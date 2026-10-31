import { cliWriterTopology, type CliWriterObservation } from './cli-writer-observation'
import type {
  AgentStatusIpcPayload,
  ParsedAgentStatusPayload
} from '../../../shared/agent-status-types'
import {
  ClaudeSessionContinuationTracker,
  resolvePaneClaudeContinuation
} from '../../../shared/agent-hook-listener/claude-session-continuation'
import type { AgentHookEventPayload } from '../../../shared/agent-hook-listener/listener-event'
import {
  isSameAgentProcess,
  type AgentProcessVerdict
} from '../../../shared/agent-process-presence'
import { probeAgentProcessPresence } from '../../../shared/agent-process-presence-probe'
import { AgentHookServerLifecycle } from './server-lifecycle'

export abstract class AgentHookServerAgentPresence extends AgentHookServerLifecycle {
  private readonly presenceChecks = new WeakMap<
    AgentHookEventPayload,
    {
      token: string
      statusHookGeneration: number
      promise: Promise<AgentProcessVerdict | null>
    }
  >()
  private readonly claudeContinuations = new ClaudeSessionContinuationTracker()

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
      presence: () =>
        presence?.process ? probeAgentProcessPresence(presence.process) : Promise.resolve(null),
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
    if (!row || row.connectionId !== null || row.agentPresence?.ended) {
      return null
    }
    if (row.agentPresence?.process && (await this.checkAgentPresence(resolved)) !== 'live') {
      return null
    }
    // Each await may have seen hooks turned off or a newer report replace this one.
    return this.statusHookGeneration === generation &&
      this.state.lastStatusByPaneKey.get(resolved) === row
      ? row.payload
      : null
  }
}
