import { AgentPromptPendingInputError } from '../../../../shared/agent-prompt-pending-input-error'
import type { AgentPromptActivity } from '../../agent-prompt-submission-verification'
import { isTerminalSendSettlementAgent } from '../../agent-prompt-submission-verification'
import { assertAgentPromptRequestActive, waitForAgentPromptDelay } from '../../orca-runtime-core'
import { OrcaRuntimeWithResubmitHeldAgentPrompt } from './terminal-agent-prompt-resubmit'

const COMPOSER_DRAFT_READ_ATTEMPTS = 3
const COMPOSER_DRAFT_RETRY_MS = 50

/**
 * Own link in the chain because `terminal-agent-prompt.ts` sits exactly on the 300-line
 * `max-lines` cap; the guard it calls could not live there.
 */
export abstract class OrcaRuntimeWithPendingComposerInputGuard extends OrcaRuntimeWithResubmitHeldAgentPrompt {
  /**
   * Permission before composer, in one call: a permission dialog's selected row also starts
   * with `❯`, so a blocked prompt must still report agent_prompt_blocked rather than
   * pending-input. Combined because `terminal-agent-prompt.ts` is exactly on the 300-line
   * `max-lines` cap and could not afford a second statement.
   */
  protected async assertAgentPromptEntryGuards(
    permissionBaseline: AgentPromptActivity,
    ptyId: string,
    options: { allowPendingInput?: boolean },
    signal?: AbortSignal
  ): Promise<void> {
    this.assertAgentPromptPermissionSafe(permissionBaseline, permissionBaseline)
    await this.assertNoPendingComposerInput(ptyId, options, signal)
  }

  // Why: the paste lands wherever the composer cursor is, and Enter submits the whole
  // row — a user's half-typed draft would ship glued to the prompt (#16289). Only a
  // rendered draft refuses; an unreadable screen is unknown and never blocks a send.
  protected async assertNoPendingComposerInput(
    ptyId: string,
    options: { allowPendingInput?: boolean },
    signal?: AbortSignal
  ): Promise<void> {
    if (options.allowPendingInput === true) {
      return
    }
    const pty = this.ptysById.get(ptyId)
    // Why: the launch agent is stale once the user swaps agents in the pane.
    const agent = pty?.foregroundAgent ?? pty?.launchAgent
    if (!isTerminalSendSettlementAgent(agent)) {
      return
    }
    const pendingInput = await this.readComposerDraft(ptyId, signal)
    if (pendingInput !== null) {
      throw new AgentPromptPendingInputError(pendingInput)
    }
  }

  // Why: a provider frame is discarded when output advanced past it — which is exactly
  // what a user's keystroke echo does — so retry briefly before giving up on evidence.
  private async readComposerDraft(ptyId: string, signal?: AbortSignal): Promise<string | null> {
    const attempts = this.providerSnapshotPreferredPtys.has(ptyId)
      ? COMPOSER_DRAFT_READ_ATTEMPTS
      : 1
    for (let attempt = 0; ; attempt += 1) {
      assertAgentPromptRequestActive(signal)
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
