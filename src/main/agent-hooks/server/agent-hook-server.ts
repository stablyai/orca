import type { ClaudePermissionHolds } from './claude-permission-hook-hold'
import { clearAllListenerCaches } from '../../../shared/agent-hook-listener/listener-state'
import { normalizeHookPayload } from '../../../shared/agent-hook-listener/normalization/normalize-hook-payload'
import { parseFormEncodedBody } from '../../../shared/agent-hook-listener/request-body'
import type { AgentHookEventPayload } from '../../../shared/agent-hook-listener/listener-event'
import type { AgentHookSource } from '../../../shared/agent-hook-listener/transport/agent-hook-relay'
import { cliWriterTopology, type CliWriterObservation } from './cli-writer-observation'
import type { AgentStatusIpcPayload } from '../../../shared/agent-status/contracts/agent-status-ipc-payload'
import type { ParsedAgentStatusPayload } from '../../../shared/agent-status/contracts/agent-status-types'
import {
  ClaudeSessionContinuationTracker,
  resolvePaneClaudeContinuation
} from '../../../shared/agent-hook-listener/claude-session-continuation'
import {
  isSameAgentProcess,
  type AgentProcessVerdict
} from '../../../shared/agent-status/process/agent-process-presence'
import { probeAgentProcessPresence } from '../../../shared/agent-status/process/agent-process-presence-probe'
import { AgentHookServerLifecycle } from './server-lifecycle'
import type { EnrichedAgentHookEventPayload } from './server-types'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session/lifecycle/agent-session-resume'
import type { OrcaSessionId } from '../../../shared/orca-session-address'
import { agentSightingOf } from '../identity/pane-agent-identities'

export class AgentHookServer extends AgentHookServerLifecycle {
  private readonly presenceChecks = new WeakMap<
    AgentHookEventPayload,
    {
      token: string
      statusHookGeneration: number
      promise: Promise<AgentProcessVerdict | null>
    }
  >()
  private readonly claudeContinuations = new ClaudeSessionContinuationTracker()

  /** The runtime that answers workers' Claude PermissionRequests; null passes them all. */
  setClaudePermissionHolds(holds: ClaudePermissionHolds | null): void {
    this.claudePermissionHooks.set(holds)
  }

  /** Issue pane-root bindings for a relay's request on the link generation current when it
   *  asked; a link restart during the read issues nothing. */
  relayPaneRootIssuer(
    connectionId: string
  ): (paneKey: string, incarnation: string, isCurrent: () => boolean) => string | undefined {
    const generation = this.relaySessions.generation(connectionId)
    return (paneKey, incarnation, isCurrent) =>
      this.relaySessions.issuePaneRoot(connectionId, generation, paneKey, incarnation, isCurrent)
  }

  /** A hook proves its sender alive; only another process can challenge the owner. */
  checkAgentPresenceAfterHook(event: AgentHookEventPayload, row: AgentHookEventPayload): void {
    const sender = event.agentPresence?.process
    const owner = row.agentPresence
    if (sender && owner?.process && !owner.ended && !isSameAgentProcess(sender, owner.process)) {
      const paneKey = this.resolvePaneKeyAlias(row.paneKey)
      const challenges = this.ownerChallengesByLiveSender
      challenges.set(paneKey, (challenges.get(paneKey) ?? 0) + 1)
      void this.checkAgentPresence(paneKey).finally(() => {
        const remaining = (challenges.get(paneKey) ?? 1) - 1
        if (remaining > 0) {
          challenges.set(paneKey, remaining)
        } else {
          challenges.delete(paneKey)
        }
      })
    }
  }

  // A live sender means the owner's exit cannot establish pane exit.
  private readonly ownerChallengesByLiveSender = new Map<string, number>()

  hasVerifiableAgentProcess(paneKey: string): boolean {
    const presence = this.state.lastStatusByPaneKey.get(
      this.resolvePaneKeyAlias(paneKey)
    )?.agentPresence
    return presence?.process !== undefined && !presence.ended
  }

  /** Pin inspection to this row so a replacement owner cannot become its subject. */
  readCliWriterObservation(expected: AgentStatusIpcPayload): CliWriterObservation | null {
    const resolved = this.resolvePaneKeyAlias(expected.paneKey)
    const row = this.state.lastStatusByPaneKey.get(resolved)
    if (
      !row ||
      row.connectionId !== null ||
      row.worktreeId !== expected.worktreeId ||
      row.providerSession?.id !== expected.providerSession?.id ||
      row.payload.agentType !== expected.agentType ||
      !('receivedAt' in row) ||
      row.receivedAt !== expected.receivedAt
    ) {
      return null
    }
    const token = this.token
    const generation = this.statusHookGeneration
    const presence = row.agentPresence
    return {
      current: () =>
        this.statusHooksEnabled &&
        this.token === token &&
        this.statusHookGeneration === generation &&
        this.state.lastStatusByPaneKey.get(resolved) === row &&
        row.agentPresence === presence,
      // An agent that reported its own end holds nothing, even while its process winds down.
      presence: () =>
        presence?.ended
          ? Promise.resolve('exited')
          : presence?.process
            ? probeAgentProcessPresence(presence.process)
            : Promise.resolve(null),
      topology: cliWriterTopology(row)
    }
  }

  /** Include retained exits proven at or after `exitedSince`. */
  async checkAgentPresenceSince(
    paneKey: string,
    exitedSince: number
  ): Promise<AgentProcessVerdict | null> {
    const verdict = await this.checkAgentPresence(paneKey)
    // A replaced owner's probe result counts only if its exit was retained.
    if (verdict !== null && verdict !== 'exited') {
      return verdict
    }
    // Why: a hook still deciding whether it succeeds the owner may yet occupy the pane; its
    // admission forgets the exit, its refusal leaves the exit to answer.
    if (this.undecidedOwnerChallenges.has(this.resolvePaneKeyAlias(paneKey))) {
      return 'unverifiable'
    }
    const exit =
      this.agentExitedAtByPaneKey.get(this.resolvePaneKeyAlias(paneKey)) ??
      this.agentExitedAtByPaneKey.get(paneKey)
    return exit !== undefined && exit.at >= exitedSince ? 'exited' : null
  }

  checkAgentPresence(paneKey: string): Promise<AgentProcessVerdict | null> {
    const resolved = this.resolvePaneKeyAlias(paneKey)
    this.followClaudeSessionContinuation(resolved)
    const row = this.state.lastStatusByPaneKey.get(resolved)
    if (!row?.agentPresence?.process || row.agentPresence.ended) {
      return Promise.resolve(null)
    }
    if (row.connectionId !== null) {
      return Promise.resolve('unverifiable')
    }
    const token = this.token
    const statusHookGeneration = this.statusHookGeneration
    const pending = this.presenceChecks.get(row)
    if (pending?.token === token && pending.statusHookGeneration === statusHookGeneration) {
      return pending.promise
    }
    const presence = row.agentPresence
    let suspended: boolean | undefined
    const check = probeAgentProcessPresence(presence.process, undefined, undefined, (observed) => {
      suspended = observed
    })
      .then((verdict) => {
        if (
          !this.statusHooksEnabled ||
          this.token !== token ||
          this.statusHookGeneration !== statusHookGeneration ||
          this.state.lastStatusByPaneKey.get(resolved) !== row ||
          row.agentPresence !== presence
        ) {
          return 'unverifiable' as const
        }
        if (verdict === 'exited') {
          this.reconcileEndedProcessForPaneKeys([resolved], {
            preserveResumeIdentity: true,
            endedPresence: { ...presence, ended: true }
          })
          if (this.ownerChallengesByLiveSender.has(resolved)) {
            this.forgetAgentExit(resolved)
          }
        } else if ((suspended === true) !== (presence.suspended === true)) {
          const { suspended: _suspended, ...unsuspended } = presence
          this.applyNormalizedStatus({
            ...row,
            isReplay: undefined,
            hookEventName: undefined,
            hasExplicitPrompt: undefined,
            agentPresence: suspended ? { ...unsuspended, suspended: true } : unsuspended
          })
        }
        return verdict
      })
      .finally(() => {
        if (this.presenceChecks.get(row)?.promise === check) {
          this.presenceChecks.delete(row)
        }
      })
    this.presenceChecks.set(row, { token, statusHookGeneration, promise: check })
    return check
  }

  /** A Claude session forked into a daemon job keeps running in this pane, but #15304 declines
   *  the job's hooks; the pane's own transcript names the fork, so rebind the row to it. */
  private followClaudeSessionContinuation(paneKey: string): void {
    const row = this.state.lastStatusByPaneKey.get(paneKey)
    if (!row || row.connectionId !== null) {
      return
    }
    const next = resolvePaneClaudeContinuation(
      this.claudeContinuations,
      this.state.lastStatusByPaneKey,
      paneKey
    )
    if (next) {
      this.applyNormalizedStatus(
        {
          ...row,
          providerSession: next,
          // Why: only the identity moved; the state is unchanged, so keep its evidence clock.
          isReplay: true,
          hookEventName: undefined,
          hasExplicitPrompt: undefined
        },
        undefined,
        'process'
      )
    }
  }

  /** Panes confirmed to run terminal agent `id`, read through the identity's reverse index;
   *  null when this host never minted it. */
  terminalAgentPlaces(id: string): { paneKey: string; worktreeId?: string }[] | null {
    if (!this.agentIdentities.isTerminalIdentity(id)) {
      return null
    }
    const places: { paneKey: string; worktreeId?: string }[] = []
    for (const place of this.agentIdentities.placesOf(id)) {
      const subject = place.canonical
        ? this.canonicalSubjectsByPane.get(place.paneKey)?.get(place.key)
        : undefined
      const row = subject
        ? this.canonicalStatusStore.getParent(subject)?.status
        : this.state.lastStatusByPaneKey.get(place.key)
      // Resume seeds, exited agents and unconfirmed restored rows prove no running agent.
      if (
        row &&
        row.providerSessionOnly !== true &&
        row.restoredUnconfirmed !== true &&
        !('agentPresence' in row && row.agentPresence?.ended === true)
      ) {
        places.push({
          paneKey: place.paneKey,
          ...(row.worktreeId ? { worktreeId: row.worktreeId } : {})
        })
      }
    }
    return places
  }

  /** The pane's terminal agent id, keyed as Copy Session ID picks its id: a confirmed live row
   *  (legacy or tmux-selected) wins even without a provider session; only an absent or
   *  unconfirmed row falls back to the pane's sleeping record. An explicit request: a failed
   *  commit is retried even during the failure backoff. */
  resolvePaneAgentId(
    paneKey: string,
    sleeping:
      | Pick<SleepingAgentSessionRecord, 'agent' | 'providerSession' | 'connectionId'>
      | undefined
  ): OrcaSessionId | null {
    const resolved = this.resolvePaneKeyAlias(paneKey)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Main admits enriched legacy rows; the shared view declares their base event type.
    const legacy = this.state.lastStatusByPaneKey.get(resolved) as
      | EnrichedAgentHookEventPayload
      | undefined
    const live = legacy ?? this.getTmuxSelectedStatus(resolved)
    if (live && live.restoredUnconfirmed !== true) {
      if (live.structuredHost) {
        return null
      }
      return live.agentIdentity?.id ?? this.agentIdentities.identify(agentSightingOf(live))
    }
    // Sleeping records carry no WSL distro; a woken agent's own hook names it. A record from a
    // foreign connection (a direct SSH relay) names no conversation on this host.
    if (!sleeping || process.platform === 'win32') {
      return null
    }
    return this.agentIdentities.identify({
      agent: sleeping.agent,
      providerSession: sleeping.providerSession,
      connectionId: sleeping.connectionId ?? null
    })
  }

  /** The last report of this pane's local agent, restored from disk or replayed from the offline
   *  spool. A report naming its process counts only while that process runs. */
  async readRestoredAgentStatus(
    paneKey: string
  ): Promise<Pick<ParsedAgentStatusPayload, 'state' | 'mainAgent' | 'sessionBoundary'> | null> {
    if (!this.statusHooksEnabled) {
      return null
    }
    const generation = this.statusHookGeneration
    await this.initializeStatusHookOwner()
    const resolved = this.resolvePaneKeyAlias(paneKey)
    const row = this.state.lastStatusByPaneKey.get(resolved)
    // A terminal report after an exit keeps the retired record only as metadata, not as its author.
    const retired = row?.agentPresence?.ended === true
    if (!row || row.connectionId !== null || (retired && row.providerSessionOnly)) {
      return null
    }
    if (
      !retired &&
      row.agentPresence?.process &&
      (await this.checkAgentPresence(resolved)) !== 'live'
    ) {
      return null
    }
    // Each await may have seen hooks turned off or a newer report replace this one.
    return this.statusHookGeneration === generation &&
      this.state.lastStatusByPaneKey.get(resolved) === row
      ? row.payload
      : null
  }
}

export const agentHookServer = new AgentHookServer()

export const _internals = {
  // Bind normalization to singleton state so tests exercise its caches.
  normalizeHookPayload: (
    source: AgentHookSource,
    body: unknown,
    expectedEnv: string
  ): AgentHookEventPayload | null =>
    normalizeHookPayload(agentHookServer._getStateForTests(), source, body, expectedEnv),
  parseFormEncodedBody,
  resetCachesForTests: (): void => {
    clearAllListenerCaches(agentHookServer._getStateForTests())
    agentHookServer._resetCanonicalStatusForTests()
    agentHookServer._resetRowOwnershipForTests()
    agentHookServer._resetPromptSentDedupeForTests()
    agentHookServer._resetConnectionTimestampWatermarksForTests()
  }
}
