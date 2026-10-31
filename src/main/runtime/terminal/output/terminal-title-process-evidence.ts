import { OrcaRuntimeWithGetUnpersistedTrackedTitleForPty } from './terminal-title-tracker'
import { detectAgentStatusFromTitle, type AgentStatus } from '../../../../shared/agent-detection'
import type { ClaudeTerminalEvidence } from '../../../../shared/claude-terminal-interrupt'

export abstract class OrcaRuntimeWithTrackedPtyTitleEvidence extends OrcaRuntimeWithGetUnpersistedTrackedTitleForPty {
  protected abstract collectPaneKeysForPty(ptyId: string): Set<string>
  observeClaudeTerminalEvidence(ptyId: string, evidence: ClaudeTerminalEvidence): void {
    if (!this.onClaudeTerminalEvidence || this.ptysById.get(ptyId)?.connectionId) {
      return
    }
    for (const paneKey of this.collectPaneKeysForPty(ptyId)) {
      this.onClaudeTerminalEvidence(paneKey, evidence)
    }
  }

  /** The PTY's agent status under this title: the program's own OSC 7501 activity while it
   *  reports one, else what the title glyph says. */
  protected classifyPtyTitleStatus(ptyId: string, rawTitle: string): AgentStatus | null {
    return (
      this.ptyTitleTrackersByPtyId.get(ptyId)?.programActivity ??
      detectAgentStatusFromTitle(rawTitle)
    )
  }
}
