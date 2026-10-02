import type { AgentHookEventPayload } from '../../../shared/agent-hook-listener/listener-event'
import {
  isSameAgentProcess,
  type AgentProcessIdentity,
  type AgentProcessPresence,
  type AgentProcessVerdict
} from '../../../shared/agent-process-presence'
import { probeAgentProcessPresence } from '../../../shared/agent-process-presence-probe'
import {
  handOverDeadOwner,
  ownerDoubtFromHook
} from '../../../shared/agent-hook-presence-transition'
import type { EnrichedAgentHookEventPayload } from './server-types'
import { isUncheckableAgentOwner } from './server-status-identity'
import { AgentHookServerLifecycle } from './server-lifecycle'
import { AgentOwnerLivenessRecheck } from '../../../shared/agent-owner-liveness-recheck'

export abstract class AgentHookServerAgentPresence extends AgentHookServerLifecycle {
  // Why keyed by pane and owner: every hook rewrites the row, and one owner needs only one probe.
  private readonly presenceChecks = new Map<
    string,
    {
      owner: AgentProcessIdentity
      check: Promise<AgentProcessVerdict | null>
      successor?: AgentProcessPresence
    }
  >()
  private readonly ownerLivenessRecheck = new AgentOwnerLivenessRecheck({
    listLiveOwnerPaneKeys: () =>
      [...this.state.lastStatusByPaneKey.values()]
        .filter((row) => row.connectionId === null && this.hasVerifiableAgentProcess(row.paneKey))
        .map((row) => row.paneKey),
    checkOwner: (paneKey) => this.checkAgentPresence(paneKey)
  })

  protected noteLiveAgentOwner(): void {
    this.ownerLivenessRecheck.noteLiveOwner()
  }

  stop(): void {
    this.ownerLivenessRecheck.stop()
    super.stop()
  }

  /** A live hook proves its own process alive; only another process's hook casts doubt on the owner. */
  checkAgentPresenceAfterHook(event: AgentHookEventPayload, row: AgentHookEventPayload): void {
    const doubt = ownerDoubtFromHook(event, row)
    if (doubt) {
      void this.checkAgentPresence(row.paneKey, undefined, doubt.successor)
    }
  }

  /** Whether this pane's owner carries a process identity that its execution host can check. */
  hasVerifiableAgentProcess(paneKey: string): boolean {
    const row = this.state.lastStatusByPaneKey.get(this.resolvePaneKeyAlias(paneKey))
    // A pane with no row has no owner to check.
    if (!row?.agentPresence?.process || row.agentPresence.ended) {
      return false
    }
    return !isUncheckableAgentOwner(row)
  }

  /** `successor` is the live process whose hook raised the doubt; it inherits a proven-dead owner's pane. */
  checkAgentPresence(
    paneKey: string,
    expectedProcess?: AgentProcessIdentity,
    successor?: AgentProcessPresence
  ): Promise<AgentProcessVerdict | null> {
    const resolved = this.resolvePaneKeyAlias(paneKey)
    const row = this.state.lastStatusByPaneKey.get(resolved)
    if (expectedProcess) {
      const recorded = row?.agentPresence
      if (!recorded?.process || !isSameAgentProcess(recorded.process, expectedProcess)) {
        return Promise.resolve('unverifiable')
      }
      if (recorded.ended) {
        return Promise.resolve('exited')
      }
    }
    const presence = row?.agentPresence
    const owner = presence?.process
    // Why: an ended owner already published its exit; an unidentified or uncheckable owner is
    // left to the legacy rules.
    if (!row || !presence || !owner || presence.ended || isUncheckableAgentOwner(row)) {
      return Promise.resolve(null)
    }
    if (row.connectionId !== null) {
      return Promise.resolve('unverifiable')
    }
    const pending = this.presenceChecks.get(resolved)
    if (pending && isSameAgentProcess(pending.owner, owner)) {
      // Why: one probe per owner; the first doubter started after the death, a later one may be
      // an agent it launched.
      pending.successor = pending.successor ?? successor
      return pending.check
    }
    const entry: {
      owner: AgentProcessIdentity
      check: Promise<AgentProcessVerdict | null>
      successor?: AgentProcessPresence
    } = { owner, check: Promise.resolve(null), successor }
    entry.check = probeAgentProcessPresence(owner)
      .then((verdict) => {
        // Why: fence on the owner, not the row object — cleanup can rewrite the row mid-probe.
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Server admission enriches every stored row with receipt and turn clocks.
        const current = this.state.lastStatusByPaneKey.get(resolved) as
          | EnrichedAgentHookEventPayload
          | undefined
        const currentOwner = current?.agentPresence
        if (
          !current ||
          !currentOwner?.process ||
          !isSameAgentProcess(currentOwner.process, owner)
        ) {
          return 'unverifiable' as const
        }
        if (verdict !== 'exited' || currentOwner.ended) {
          return verdict
        }
        if (entry.successor) {
          this.adoptPaneOwner(current, entry.successor)
        } else {
          this.reconcileEndedProcessForPaneKeys([resolved], {
            kind: 'owner-exited',
            presence: { ...presence, ended: true }
          })
        }
        return verdict
      })
      .finally(() => {
        if (this.presenceChecks.get(resolved) === entry) {
          this.presenceChecks.delete(resolved)
        }
      })
    this.presenceChecks.set(resolved, entry)
    return entry.check
  }

  /** The row already carries the successor's own status; only the recorded owner was stale. */
  private adoptPaneOwner(
    current: EnrichedAgentHookEventPayload,
    successor: AgentProcessPresence
  ): void {
    const adopted: EnrichedAgentHookEventPayload = {
      ...current,
      ...handOverDeadOwner(current, successor)
    }
    if (!this.writeLegacyStatusRow(adopted)) {
      return
    }
    this.commitStatusRowMutation(current, adopted)
    this.scheduleStatusPersist()
    this.emitEnrichedStatus(adopted)
  }
}
