import { ownerDoubtFromHook } from '../shared/agent-hook-presence-transition'
import type { AgentHookEventPayload } from '../shared/agent-hook-listener/listener-event'
import { canAdmitAgentForeground } from '../shared/agent-foreground-admission'
import {
  isSameAgentProcess,
  type AgentProcessIdentity,
  type AgentProcessPresence
} from '../shared/agent-process-presence'
import {
  isSuspendedAgentProcess,
  probeAgentProcessPresence
} from '../shared/agent-process-presence-probe'
import { AgentOwnerLivenessRecheck } from '../shared/agent-owner-liveness-recheck'

type PendingCheck = {
  owner: AgentProcessIdentity
  check: Promise<void>
}

export class RelayAgentPresence {
  // Why keyed by pane and owner: every hook rewrites the row, and one owner needs only one probe.
  private readonly pending = new Map<string, PendingCheck>()
  private readonly ownerLivenessRecheck: AgentOwnerLivenessRecheck

  constructor(
    private readonly host: {
      rows: () => Iterable<AgentHookEventPayload>
      checkOwner: (paneKey: string) => Promise<void>
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

  /** Register accepted owners with the shared clock; hook evidence may also request a check. */
  observeHook(
    incoming: AgentHookEventPayload,
    row: AgentHookEventPayload,
    doubt: boolean
  ): Promise<void> | undefined {
    if (row.agentPresence?.process && !row.agentPresence.ended) {
      this.ownerLivenessRecheck.noteLiveOwner()
    }
    const doubted = doubt && ownerDoubtFromHook(incoming, row.agentPresence)
    if (doubted) {
      return this.host.checkOwner(row.paneKey)
    }
    return undefined
  }

  stop(): void {
    this.ownerLivenessRecheck.stop()
  }

  /** Publish only proven exit of the currently recorded owner. */
  check(
    row: AgentHookEventPayload | undefined,
    current: () => AgentHookEventPayload | undefined,
    publish: (event: AgentHookEventPayload) => void
  ): Promise<void> {
    const presence = row?.agentPresence
    const owner = presence?.process
    if (!row || !presence || !owner || presence.ended) {
      return Promise.resolve()
    }
    const existing = this.pending.get(row.paneKey)
    if (existing && isSameAgentProcess(existing.owner, owner)) {
      return existing.check
    }
    const entry: PendingCheck = { owner, check: Promise.resolve() }
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
        publish({
          ...latest,
          hookEventName: 'AgentProcessExit',
          agentPresence: { ...presence, ended: true }
        })
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

/** A live owner that a different foreground process now doubts; only a stop proves it yielded. */
function doubtedRelayOwner(
  before: AgentHookEventPayload | undefined,
  presence: AgentProcessPresence
): AgentProcessIdentity | undefined {
  const recorded = before?.agentPresence
  const process = recorded?.ended ? undefined : recorded?.process
  return process && presence.process && !isSameAgentProcess(process, presence.process)
    ? process
    : undefined
}

/** The replay-cache row for an owner this host's foreground capture admits, or undefined. */
function relayForegroundOwnerRow(
  before: AgentHookEventPayload | undefined,
  scope: Pick<AgentHookEventPayload, 'paneKey' | 'tabId' | 'worktreeId' | 'terminalHandle'>,
  presence: AgentProcessPresence,
  recordedSuspended: boolean
): AgentHookEventPayload | undefined {
  const recorded = before?.agentPresence
  if (
    !canAdmitAgentForeground(
      before && {
        presence: recorded,
        connectionId: before.connectionId,
        worktreeId: before.worktreeId
      },
      presence,
      { connectionId: null, worktreeId: scope.worktreeId },
      recordedSuspended
    )
  ) {
    return undefined
  }
  // Why: the cache encodes an owner on its row; a turn keeps its fields, an ended owner's resume
  // identity stays with that owner.
  const carried = before && !recorded?.ended ? before : undefined
  return carried && !carried.providerSessionOnly
    ? { ...carried, ...scope, agentPresence: presence }
    : {
        ...scope,
        connectionId: null,
        agentPresence: presence,
        payload: carried?.payload ?? { state: 'done', prompt: '', agentType: presence.agent },
        providerSessionOnly: true,
        ...(carried?.providerSession ? { providerSession: carried.providerSession } : {})
      }
}

/** The relay host's own capture: admits synchronously unless a live owner must first prove it stopped. */
export function admitRelayForegroundOwner(
  current: () => AgentHookEventPayload | undefined,
  scope: Pick<AgentHookEventPayload, 'paneKey' | 'tabId' | 'worktreeId' | 'terminalHandle'>,
  presence: AgentProcessPresence,
  apply: (row: AgentHookEventPayload) => void
): Promise<void> {
  const before = current()
  const admit = (suspended: boolean): void => {
    const row =
      current() === before ? relayForegroundOwnerRow(before, scope, presence, suspended) : undefined
    if (row) {
      apply(row)
    }
  }
  const doubted = doubtedRelayOwner(before, presence)
  if (!doubted) {
    admit(false)
    return Promise.resolve()
  }
  return isSuspendedAgentProcess(doubted)
    .catch(() => false)
    .then(admit)
}
