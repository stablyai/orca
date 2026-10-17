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

  /** A live hook proves its own process alive; only another process's hook casts doubt on the owner. */
  checkAgentPresenceAfterHook(event: AgentHookEventPayload, row: AgentHookEventPayload): void {
    const sender = event.agentPresence?.process
    const owner = row.agentPresence
    if (sender && owner?.process && !owner.ended && !isSameAgentProcess(sender, owner.process)) {
      const paneKey = this.resolvePaneKeyAlias(row.paneKey)
      void this.checkAgentPresence(paneKey, true)
    }
  }

  // Why: a live process already reports from these panes, so their owner's exit is not the pane's.
  private readonly ownerChallengesByLiveSender = new Map<string, number>()

  /** Whether this pane's owner carries a process identity that its execution host can check. */
  hasVerifiableAgentProcess(paneKey: string): boolean {
    const presence = this.state.lastStatusByPaneKey.get(
      this.resolvePaneKeyAlias(paneKey)
    )?.agentPresence
    return presence?.process !== undefined && !presence.ended
  }

  /** As checkAgentPresence, but keeps an exit this host proved at or after `exitedSince`. */
  async checkAgentPresenceSince(
    paneKey: string,
    exitedSince: number
  ): Promise<AgentProcessVerdict | null> {
    const verdict = await this.checkAgentPresence(paneKey)
    // Why exits too: a probe's exit counts only if retained (not a replaced owner's).
    if (verdict !== null && verdict !== 'exited') {
      return verdict
    }
    const exit =
      this.agentExitedAtByPaneKey.get(this.resolvePaneKeyAlias(paneKey)) ??
      this.agentExitedAtByPaneKey.get(paneKey)
    return exit !== undefined && exit.at >= exitedSince ? 'exited' : null
  }

  /** A live sender challenges an old process without declaring the whole pane exited. */
  checkAgentPresence(paneKey: string, liveSender = false): Promise<AgentProcessVerdict | null> {
    const resolved = this.resolvePaneKeyAlias(paneKey)
    if (liveSender) {
      const challenges = this.ownerChallengesByLiveSender
      challenges.set(resolved, (challenges.get(resolved) ?? 0) + 1)
      return this.checkAgentPresence(resolved).finally(() => {
        const remaining = (challenges.get(resolved) ?? 1) - 1
        if (remaining > 0) {
          challenges.set(resolved, remaining)
        } else {
          challenges.delete(resolved)
        }
      })
    }
    const row = this.state.lastStatusByPaneKey.get(resolved)
    // Why: an ended owner already published its exit, and an owner no hook identified cannot be checked.
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
}
