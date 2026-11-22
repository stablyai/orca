import { AgentPromptPermissionReturnedError } from './agent-prompt-permission-hold'
import type { AgentPromptActivity } from './agent-prompt-submission-verification'
import type { AgentPromptExpectedBinding } from './agent-prompt-write-options'
import { OrcaRuntimeWithResubmitHeldAgentPrompt } from './terminal-agent-prompt-resubmit'
import { detectTerminalWaitBlockedReason } from '../wait/terminal-wait-detection'
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
    permissionBaseline: AgentPromptActivity
  ): Promise<RuntimeTerminalWaitBlockedReason | null> {
    const screen = await this.readCurrentTerminalWaitScreen(ptyId)
    // A composer still showing a draft is what Enter reaches; a dialog takes its place. This also
    // keeps a brief shown inline, whose text may read like a dialog, from holding itself back.
    const dialog =
      screen && !screen.draft ? detectTerminalWaitBlockedReason(screen.lines.join('\n')) : null
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
