import type { AgentStatus } from '../../../../shared/agent-detection'
import { classifyJcodePtyTitleStatus } from '../../jcode-title-status'
import { OrcaRuntimeWithGetUnpersistedTrackedTitleForPty } from './terminal-title-tracker'

export abstract class OrcaRuntimeWithTitleClassification extends OrcaRuntimeWithGetUnpersistedTrackedTitleForPty {
  protected abstract collectPaneKeysForPty(ptyId: string): Set<string>

  protected observeJcodeTerminalTitle(ptyId: string, title: string | null): void {
    if (!this.onJcodeTerminalTitle || this.ptysById.get(ptyId)?.connectionId) {
      return
    }
    for (const paneKey of this.collectPaneKeysForPty(ptyId)) {
      this.onJcodeTerminalTitle(paneKey, title)
    }
  }

  /** Explicit OSC 7501 activity outranks title status. */
  protected classifyPtyTitleStatus(ptyId: string, rawTitle: string): AgentStatus | null {
    const pty = this.ptysById.get(ptyId)
    return classifyJcodePtyTitleStatus(
      rawTitle,
      this.ptyTitleTrackersByPtyId.get(ptyId)?.programActivity,
      pty,
      () => {
        const tab = this.mobileSessionTabsByWorktree
          .get(pty?.worktreeId ?? '')
          ?.tabs.find(
            (candidate) =>
              candidate.type === 'terminal' &&
              candidate.ptyId === ptyId &&
              candidate.parentTabId === pty?.tabId
          )
        return tab?.type === 'terminal' ? tab.launchAgent : undefined
      },
      this.getAgentProviderSessionRowsForPaneFn
    )
  }
}
