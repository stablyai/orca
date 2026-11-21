import type {
  AgentProcessIdentity,
  AgentProcessPresence
} from '../../../shared/agent-status/process/agent-process-presence'
import { probeAgentProcessPresence } from '../../../shared/agent-status/process/agent-process-presence-probe'
import type { EndedProcessReconciliationOptions } from './server-cleanup'
import { AgentHookServerTabCleanup } from './server-tab-cleanup'

type MarkedAgent = { presence: AgentProcessPresence; process: AgentProcessIdentity }

/** A command mark proves no exit on its own: Ctrl-Z and a shell nested in the agent finish
 *  commands too. A local agent's own process answers instead, a stopped one counting as alive. */
export abstract class AgentHookServerMarkedExitProof extends AgentHookServerTabCleanup {
  /** Agents a mark did not prove gone (stopped, or under a nested shell): the pane's next mark asks again. */
  private readonly aliveAfterMark = new Map<string, MarkedAgent>()

  override retireProcessAuthority(
    paneKey: string,
    options?: Pick<EndedProcessReconciliationOptions, 'confirmedExit'> & { launchRetired?: true }
  ): void {
    const resolved = this.resolvePaneKeyAlias(paneKey)
    // The retirement revokes the row a later probe would read, so the process is read first.
    const row = this.state.lastStatusByPaneKey.get(resolved)
    const presence =
      options?.confirmedExit === true &&
      row?.connectionId === null &&
      this.hasVerifiableAgentProcess(resolved)
        ? row.agentPresence
        : undefined
    super.retireProcessAuthority(paneKey, options)
    const marked = presence?.process
      ? { presence, process: presence.process }
      : options?.launchRetired
        ? this.aliveAfterMark.get(resolved)
        : undefined
    if (marked) {
      void this.recordMarkedExitIfGone(resolved, marked)
    }
  }

  private async recordMarkedExitIfGone(resolved: string, marked: MarkedAgent): Promise<void> {
    const verdict = await probeAgentProcessPresence(marked.process).catch(() => null)
    const now = this.state.lastStatusByPaneKey.get(resolved)?.agentPresence?.process
    this.aliveAfterMark.delete(resolved)
    // A newer agent in the pane owns it now; this one's end is no longer its news.
    if (now && now.pid !== marked.process.pid) {
      return
    }
    if (verdict === 'exited') {
      this.recordPaneAgentExit(resolved, { ...marked.presence, ended: true })
    } else {
      // Alive, stopped (which reads as unverifiable) or unread: not proven gone.
      this.aliveAfterMark.set(resolved, marked)
    }
  }
}
