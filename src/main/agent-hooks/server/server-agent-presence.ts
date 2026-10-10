import type { AgentHookEventPayload } from '../../../shared/agent-hook-listener/listener-event'
import type { AgentProcessVerdict } from '../../../shared/agent-process-presence'
import { probeAgentProcessPresence } from '../../../shared/agent-process-presence-probe'
import { AgentHookServerLifecycle } from './server-lifecycle'
import { currentOwner } from '../../../shared/agent-hook-presence-transition'

export abstract class AgentHookServerAgentPresence extends AgentHookServerLifecycle {
  private readonly presenceChecks = new WeakMap<
    AgentHookEventPayload,
    Promise<AgentProcessVerdict | null>
  >()

  /** Whether this pane's owner carries a process identity that its execution host can check. */
  hasVerifiableAgentProcess(paneKey: string): boolean {
    return (
      currentOwner(this.state.lastStatusByPaneKey.get(this.resolvePaneKeyAlias(paneKey)))
        ?.process !== undefined
    )
  }

  checkAgentPresence(paneKey: string): Promise<AgentProcessVerdict | null> {
    return this.paneOwnerProbes.check(paneKey)
  }

  protected probeOwnerProcess(paneKey: string): Promise<AgentProcessVerdict | null> {
    const resolved = this.resolvePaneKeyAlias(paneKey)
    const row = this.state.lastStatusByPaneKey.get(resolved)
    const presence = currentOwner(row)
    // Why: an ended owner already published its exit, and an owner no hook identified cannot be checked.
    if (!row || !presence?.process) {
      return Promise.resolve(null)
    }
    if (row.connectionId !== null) {
      return Promise.resolve('unverifiable')
    }
    const pending = this.presenceChecks.get(row)
    if (pending) {
      return pending
    }
    const check = probeAgentProcessPresence(presence.process)
      .then((verdict) => {
        if (this.state.lastStatusByPaneKey.get(resolved) !== row) {
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
}
