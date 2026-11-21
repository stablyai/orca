import {
  isSameAgentProcess,
  type AgentProcessIdentity,
  type AgentProcessPresence
} from '../../../shared/agent-status/process/agent-process-presence'
import { probeAgentProcessPresence } from '../../../shared/agent-status/process/agent-process-presence-probe'
import type { EndedProcessReconciliationOptions } from './server-cleanup'
import { AgentHookServerTabCleanup } from './server-tab-cleanup'

type MarkedAgent = { presence: AgentProcessPresence; process: AgentProcessIdentity }

/** Tells the terminal lifecycle of each agent end something proved, and proves the ends a
 *  command mark only suggests: Ctrl-Z and a shell nested in the agent finish commands too, so a
 *  local agent's own process answers, a stopped one counting as not gone. */
export abstract class AgentHookServerMarkedExitProof extends AgentHookServerTabCleanup {
  /** Agents a mark did not prove gone (stopped, or under a nested shell): the pane's next mark asks again. */
  private readonly aliveAfterMark = new Map<string, MarkedAgent>()

  protected override reconcileEndedProcess(
    paneKeys: Iterable<string>,
    options: EndedProcessReconciliationOptions | undefined,
    clearPane: (paneKey: string) => void
  ): { cleared: number; untouched: string[] } {
    const keys = [...paneKeys]
    const result = super.reconcileEndedProcess(keys, options, clearPane)
    // Proof is a probe that found the process gone, the agent's own end hook, or the host finding
    // the shell alone. A mark standing where no host can prove it (SSH, WSL) may be a Ctrl-Z.
    const ended = options?.endedPresence
    for (const paneKey of ended || options?.confirmedExit === 'proven' ? keys : []) {
      const resolved = this.resolvePaneKeyAlias(paneKey)
      const now = this.state.lastStatusByPaneKey.get(resolved)?.agentPresence
      // A newer live agent owns the pane: the old one's end is not its news.
      if (
        !now?.process ||
        now.ended ||
        (ended?.process && isSameAgentProcess(now.process, ended.process))
      ) {
        this.terminalPaneLifecycle?.agentExited?.(resolved)
      }
    }
    return result
  }

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
    if (now && !isSameAgentProcess(now, marked.process)) {
      return
    }
    if (verdict === 'exited') {
      this.reconcileEndedProcessForPaneKeys([resolved], {
        preserveResumeIdentity: true,
        endedPresence: { ...marked.presence, ended: true }
      })
    } else {
      // Alive, stopped (which reads as unverifiable) or unread: not proven gone.
      this.aliveAfterMark.set(resolved, marked)
    }
  }
}
