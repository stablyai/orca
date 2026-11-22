import { AgentPromptPermissionReturnedError } from './agent-prompt-permission-hold'
import type { AgentPromptActivity } from './agent-prompt-submission-verification'
import type {
  AgentPromptExpectedBinding,
  RuntimeAgentPromptWriteOptions
} from './agent-prompt-write-options'
import { waitForAgentPromptPromise } from './agent-prompt-signals'
import { OrcaRuntimeWithResubmitHeldAgentPrompt } from './terminal-agent-prompt-resubmit'
import { detectTerminalWaitBlockedReason } from '../wait/terminal-wait-detection'
import {
  projectTerminalVisibleLines,
  restoreProjectedComposerDraft
} from '../view/orca-runtime-terminal-projection'
import { isHeldAgentPromptDraft } from '../../../../shared/agent-launch/startup/agent-prompt-injection'
import type { RuntimeTerminalWaitBlockedReason } from '../../../../shared/terminal/runtime/runtime-terminal-contracts'
import type { RuntimeTerminalPromptSubmitHold } from '../../../../shared/terminal/runtime/runtime-terminal-send-contract'

const SUBMIT_HOLD_SCREEN_RETRIES = 2

/** A dialog on a screen, read with the composer's draft put back, unless that draft is exactly the
 *  brief: its own text may read like a dialog. Any other draft may be a dialog's selected row. */
function readSubmitHoldOnScreen(
  screen: { lines: string[]; draft?: string },
  briefDrafts: readonly string[]
): RuntimeTerminalWaitBlockedReason | null {
  const holdsBrief = briefDrafts.some((brief) => isHeldAgentPromptDraft(screen.draft, brief, 0))
  const lines = holdsBrief
    ? screen.lines
    : restoreProjectedComposerDraft(screen.lines, screen.draft)
  return detectTerminalWaitBlockedReason(lines.join('\n'))
}

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

  /** Runs the last write check before Enter. A worker brief (`withholdSubmitOnDialog`) first reads
   *  what Enter would reach, and again after that check with no await before Enter; returns what
   *  Enter would answer or submit instead, so the caller leaves the brief unsent. */
  protected async guardAgentPromptSubmit(
    handle: string,
    ptyId: string,
    options: RuntimeAgentPromptWriteOptions,
    write: {
      permissionBaseline: AgentPromptActivity
      pastedAt: number
      signal: AbortSignal
      beforeWrite: () => Promise<void>
    }
  ): Promise<RuntimeTerminalPromptSubmitHold | null> {
    // Why only acceptQueued: its receipt carries the withheld Enter back to a caller that reports it.
    if (!options.withholdSubmitOnDialog || !options.acceptQueued || !options.requestId) {
      await write.beforeWrite()
      return null
    }
    const prompt = options.promptForSchedule
    // The composer may show the typed lead line ahead of the pasted brief.
    const briefDrafts =
      prompt === undefined
        ? []
        : options.leadLine
          ? [prompt, `${options.leadLine} ${prompt}`]
          : [prompt]
    const held = await waitForAgentPromptPromise(
      this.readAgentPromptSubmitHold(handle, ptyId, write.permissionBaseline, briefDrafts),
      write.signal
    )
    if (held) {
      return held
    }
    await write.beforeWrite()
    return this.readAgentPromptSubmitHoldNow(
      handle,
      ptyId,
      write.permissionBaseline,
      briefDrafts,
      write.pastedAt
    )
  }

  /** What an Enter after the paste would answer instead of submitting it, on the caught-up screen:
   *  a dialog or a permission prompt; null when neither, or the screen can't be read in time. */
  protected async readAgentPromptSubmitHold(
    handle: string,
    ptyId: string,
    permissionBaseline: AgentPromptActivity,
    briefDrafts: readonly string[]
  ): Promise<RuntimeTerminalPromptSubmitHold | null> {
    let screen = await this.readCurrentTerminalWaitScreen(ptyId)
    // Null means output arrived during the read, perhaps the dialog itself: read it again.
    for (let retry = 0; screen === null && retry < SUBMIT_HOLD_SCREEN_RETRIES; retry += 1) {
      screen = await this.readCurrentTerminalWaitScreen(ptyId)
    }
    return (
      (screen ? readSubmitHoldOnScreen(screen, briefDrafts) : null) ??
      this.readAgentPromptPermissionHold(handle, ptyId, permissionBaseline)
    )
  }

  /** The same check with no await before Enter, on the live grid, plus input someone else typed
   *  since the paste, which Enter would submit along with the brief. */
  protected readAgentPromptSubmitHoldNow(
    handle: string,
    ptyId: string,
    permissionBaseline: AgentPromptActivity,
    briefDrafts: readonly string[],
    pastedAt: number
  ): RuntimeTerminalPromptSubmitHold | null {
    const typedAt = this.terminalRunFacts.readLastDrivingInputAt(ptyId)
    if (typedAt !== null && typedAt >= pastedAt) {
      return 'terminal-input'
    }
    const state = this.readWholeScreenModel(ptyId)
    return (
      (state
        ? readSubmitHoldOnScreen(projectTerminalVisibleLines(state.emulator), briefDrafts)
        : null) ?? this.readAgentPromptPermissionHold(handle, ptyId, permissionBaseline)
    )
  }

  private readAgentPromptPermissionHold(
    handle: string,
    ptyId: string,
    permissionBaseline: AgentPromptActivity
  ): RuntimeTerminalPromptSubmitHold | null {
    return this.isAgentPromptPermissionBlocked(
      permissionBaseline,
      this.getAgentPromptActivity(handle, ptyId)
    )
      ? 'agent-approval-prompt'
      : null
  }
}
