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
    Promise<AgentProcessVerdict | null>
  >()
  private readonly claudeContinuations = new ClaudeSessionContinuationTracker()

  /** A live hook proves its own process alive; only another process's hook casts doubt on the owner. */
  checkAgentPresenceAfterHook(event: AgentHookEventPayload, row: AgentHookEventPayload): void {
    const sender = event.agentPresence?.process
    const owner = row.agentPresence
    if (sender && owner?.process && !owner.ended && !isSameAgentProcess(sender, owner.process)) {
      void this.checkAgentPresence(row.paneKey)
    }
  }

  /** Whether this pane's owner carries a process identity that its execution host can check. */
  hasVerifiableAgentProcess(paneKey: string): boolean {
    const presence = this.state.lastStatusByPaneKey.get(
      this.resolvePaneKeyAlias(paneKey)
    )?.agentPresence
    return presence?.process !== undefined && !presence.ended
  }

  checkAgentPresence(paneKey: string): Promise<AgentProcessVerdict | null> {
    const resolved = this.resolvePaneKeyAlias(paneKey)
    this.followClaudeSessionContinuation(resolved)
    const row = this.state.lastStatusByPaneKey.get(resolved)
    // Why: an ended owner already published its exit, and an owner no hook identified cannot be checked.
    if (!row?.agentPresence?.process || row.agentPresence.ended) {
      return Promise.resolve(null)
    }
    if (row.connectionId !== null) {
      return Promise.resolve('unverifiable')
    }
    const pending = this.presenceChecks.get(row)
    if (pending) {
      return pending
    }
    const presence = row.agentPresence
    const check = probeAgentProcessPresence(presence.process)
      .then((verdict) => {
        if (
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
        }
        return verdict
      })
      .finally(() => {
        if (this.presenceChecks.get(row) === check) {
          this.presenceChecks.delete(row)
        }
      })
    this.presenceChecks.set(row, check)
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
}
