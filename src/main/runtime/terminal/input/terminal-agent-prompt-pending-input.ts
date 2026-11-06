import { AgentPromptPendingInputError } from './agent-prompt-permission-hold'
import { isTerminalSendSettlementAgent } from './agent-prompt-submission-verification'
import { assertAgentPromptRequestActive, waitForAgentPromptDelay } from './agent-prompt-signals'
import { isCompleteAgentPromptDraft } from '../../../../shared/agent-launch/startup/agent-prompt-injection'
import { OrcaRuntimeWithResubmitHeldAgentPrompt } from './terminal-agent-prompt-resubmit'

const COMPOSER_DRAFT_READ_ATTEMPTS = 3
const COMPOSER_DRAFT_RETRY_MS = 50

// Own link in the chain: terminal-agent-prompt.ts has no max-lines budget left for the guard.
export abstract class OrcaRuntimeWithPendingComposerInputGuard extends OrcaRuntimeWithResubmitHeldAgentPrompt {
  /**
   * Refuse to paste over unsent composer text (#16289); an unreadable screen never refuses.
   * A composer showing exactly `prompt` is the agent's own held paste or #38401 echo, not a draft.
   */
  protected async assertNoPendingComposerInput(
    ptyId: string,
    prompt: string | undefined,
    signal?: AbortSignal
  ): Promise<void> {
    const pty = this.ptysById.get(ptyId)
    // Why: the launch agent is stale once the user swaps agents in the pane.
    const agent = pty?.foregroundAgent ?? pty?.launchAgent
    if (!isTerminalSendSettlementAgent(agent)) {
      return
    }
    const pendingInput = await this.readComposerDraft(ptyId, signal)
    if (pendingInput !== null && !isCompleteAgentPromptDraft(pendingInput, prompt ?? '')) {
      throw new AgentPromptPendingInputError(pendingInput)
    }
  }

  // Why retry: a provider frame is discarded when output, such as a keystroke echo, outran it.
  private async readComposerDraft(ptyId: string, signal?: AbortSignal): Promise<string | null> {
    const attempts = this.providerSnapshotPreferredPtys.has(ptyId)
      ? COMPOSER_DRAFT_READ_ATTEMPTS
      : 1
    for (let attempt = 0; ; attempt += 1) {
      assertAgentPromptRequestActive(signal)
      // Why: a provider frame can lag the renderer's local echo; the renderer only adds refusals.
      const rendererDraft = this.providerSnapshotPreferredPtys.has(ptyId)
        ? (await this.readRendererVisibleSnapshotLines(ptyId)).draft
        : undefined
      if (rendererDraft?.trim()) {
        return rendererDraft
      }
      const visibleState = await this.readVisibleTerminalState(ptyId)
      if (visibleState) {
        return visibleState.draft?.trim() ? visibleState.draft : null
      }
      if (attempt >= attempts - 1) {
        return null
      }
      await waitForAgentPromptDelay(COMPOSER_DRAFT_RETRY_MS, signal)
    }
  }
}
