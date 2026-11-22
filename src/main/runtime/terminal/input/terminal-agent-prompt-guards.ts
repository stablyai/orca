import { AgentPromptPermissionReturnedError } from './agent-prompt-permission-hold'
import type { AgentPromptActivity } from './agent-prompt-submission-verification'
import type { AgentPromptExpectedBinding } from './agent-prompt-write-options'
import { OrcaRuntimeWithResubmitHeldAgentPrompt } from './terminal-agent-prompt-resubmit'
import { detectTerminalWaitBlockedReason } from '../wait/terminal-wait-detection'
import { restoreProjectedComposerDraft } from '../view/orca-runtime-terminal-projection'
import { isHeldAgentPromptDraft } from '../../../../shared/agent-launch/startup/agent-prompt-injection'
import type { RuntimeTerminalWaitBlockedReason } from '../../../../shared/terminal/runtime/runtime-terminal-contracts'

/** Checks a prompt write runs before it types or submits. */
export abstract class OrcaRuntimeWithAgentPromptWriteGuards extends OrcaRuntimeWithResubmitHeldAgentPrompt {
  protected assertAgentPromptExpectedBinding(
    handle: string,
    expected: AgentPromptExpectedBinding | undefined
  ): void {
    if (!expected) {
      return
    }
    const current = this.getTerminalPromptRequestBinding(handle)
    if (
      current.ptyId !== expected.ptyId ||
      current.processIncarnation !== expected.processIncarnation
    ) {
      throw new Error('terminal_handle_stale')
    }
  }

  /** Under `wait`, a pre-paste refusal is the hold's to resume rather than the caller's to see. */
  protected throwIfAgentPromptPermissionReturned(
    baseline: AgentPromptActivity,
    current: AgentPromptActivity
  ): void {
    if (this.isAgentPromptPermissionBlocked(baseline, current)) {
      throw new AgentPromptPermissionReturnedError()
    }
  }

  /** What an Enter after the paste would answer instead of submitting it: a dialog the caught-up
   *  screen shows, or a permission prompt; null when neither, or the screen can't be read in time. */
  protected async readAgentPromptSubmitHold(
    handle: string,
    ptyId: string,
    permissionBaseline: AgentPromptActivity,
    prompt: string | undefined
  ): Promise<RuntimeTerminalWaitBlockedReason | null> {
    const screen = await this.readCurrentTerminalWaitScreen(ptyId)
    // A composer showing exactly this brief is what Enter reaches; reading the brief's own text,
    // which may sound like a dialog, must not hold it back. Any other draft may be a dialog's row.
    const holdsBrief = prompt !== undefined && isHeldAgentPromptDraft(screen?.draft, prompt, 0)
    const dialog =
      screen && !holdsBrief
        ? detectTerminalWaitBlockedReason(
            restoreProjectedComposerDraft(screen.lines, screen.draft).join('\n')
          )
        : null
    return (
      dialog ??
      (this.isAgentPromptPermissionBlocked(
        permissionBaseline,
        this.getAgentPromptActivity(handle, ptyId)
      )
        ? 'agent-approval-prompt'
        : null)
    )
  }
}
