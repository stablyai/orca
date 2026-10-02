import type { AgentHookEventPayload } from '../shared/agent-hook-listener/listener-event'
import {
  isSameAgentProcess,
  type AgentProcessIdentity,
  type AgentProcessPresence
} from '../shared/agent-process-presence'
import { handOverDeadOwner, ownerDoubtFromHook } from '../shared/agent-hook-presence-transition'
import { probeAgentProcessPresence } from '../shared/agent-process-presence-probe'
import { AgentOwnerLivenessRecheck } from '../shared/agent-owner-liveness-recheck'

type PendingCheck = {
  owner: AgentProcessIdentity
  check: Promise<void>
  successor?: AgentProcessPresence
}

export class RelayAgentPresence {
  // Why keyed by pane and owner: every hook rewrites the row, and one owner needs only one probe.
  private readonly pending = new Map<string, PendingCheck>()
  private readonly ownerLivenessRecheck: AgentOwnerLivenessRecheck

  constructor(
    private readonly host: {
      rows: () => Iterable<AgentHookEventPayload>
      checkOwner: (paneKey: string, successor?: AgentProcessPresence) => Promise<void>
    }
  ) {
    this.ownerLivenessRecheck = new AgentOwnerLivenessRecheck({
      listLiveOwnerPaneKeys: () =>
        [...host.rows()]
          .filter((row) => row.agentPresence?.process && !row.agentPresence.ended)
          .map((row) => row.paneKey),
      checkOwner: (paneKey) => host.checkOwner(paneKey)
    })
  }

  /** A live hook proves its own process alive; only another process's hook casts doubt on the owner. */
  observeHook(incoming: AgentHookEventPayload, row: AgentHookEventPayload, doubt: boolean): void {
    if (row.agentPresence?.process && !row.agentPresence.ended) {
      this.ownerLivenessRecheck.noteLiveOwner()
    }
    const doubted = doubt ? ownerDoubtFromHook(incoming, row) : undefined
    if (doubted) {
      void this.host.checkOwner(row.paneKey, doubted.successor)
    }
  }

  stop(): void {
    this.ownerLivenessRecheck.stop()
  }

  /** `publish` gets a handover when a live process doubted the owner, otherwise the owner's exit. */
  check(
    row: AgentHookEventPayload | undefined,
    current: () => AgentHookEventPayload | undefined,
    publish: (event: AgentHookEventPayload, handover: boolean) => void,
    successor?: AgentProcessPresence
  ): Promise<void> {
    const presence = row?.agentPresence
    const owner = presence?.process
    if (!row || !presence || !owner || presence.ended) {
      return Promise.resolve()
    }
    const existing = this.pending.get(row.paneKey)
    if (existing && isSameAgentProcess(existing.owner, owner)) {
      // Why: the first doubter started after the death; a later one may be an agent it launched.
      existing.successor = existing.successor ?? successor
      return existing.check
    }
    const entry: PendingCheck = { owner, check: Promise.resolve(), successor }
    entry.check = probeAgentProcessPresence(owner)
      .then((verdict) => {
        // Why: fence on the owner, not the row object — the doubting process keeps rewriting it.
        const latest = current()
        const latestOwner = latest?.agentPresence
        if (
          verdict !== 'exited' ||
          !latest ||
          !latestOwner?.process ||
          latestOwner.ended ||
          !isSameAgentProcess(latestOwner.process, owner)
        ) {
          return
        }
        if (entry.successor) {
          publish(handOverDeadOwner(latest, entry.successor), true)
          return
        }
        publish(
          {
            ...latest,
            hookEventName: 'AgentProcessExit',
            agentPresence: { ...presence, ended: true }
          },
          false
        )
      })
      .finally(() => {
        if (this.pending.get(row.paneKey) === entry) {
          this.pending.delete(row.paneKey)
        }
      })
    this.pending.set(row.paneKey, entry)
    return entry.check
  }
}
