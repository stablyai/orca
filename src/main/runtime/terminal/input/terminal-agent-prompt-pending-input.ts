import { AgentPromptPendingInputError } from './agent-prompt-permission-hold'
import {
  type AgentPromptActivity,
  isTerminalSendSettlementAgent
} from './agent-prompt-submission-verification'
import { assertAgentPromptRequestActive, waitForAgentPromptDelay } from './agent-prompt-signals'
import { isCompleteAgentPromptDraft } from '../../../../shared/agent-launch/startup/agent-prompt-injection'
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
    prompt: string | undefined,
    signal?: AbortSignal
  ): Promise<void> {
    this.assertAgentPromptPermissionSafe(permissionBaseline, permissionBaseline)
    await this.assertNoPendingComposerInput(ptyId, prompt, signal)
  }

  /**
   * Second read, after the user hook. A sendable precondition can poll for up to a second,
   * which is ample time for the user to start typing, so a draft that appears during
   * `beforeWrite` must refuse rather than be pasted onto. Takes `assertWritable` and runs it
   * because it replaces that call at the site — `terminal-agent-prompt.ts` is on the
   * 300-line `max-lines` cap and cannot afford an extra statement. Order matters: the screen
   * read awaits, and a pty that stopped or a handle that went stale during it would otherwise
   * reach the write unchecked, so `assertWritable` stays the LAST thing before the caller writes.
   */
  protected async assertComposerStillClear(
    ptyId: string,
    prompt: string | undefined,
    signal: AbortSignal,
    assertWritable: (signal: AbortSignal) => void
  ): Promise<void> {
    await this.assertNoPendingComposerInput(ptyId, prompt, signal)
    assertWritable(signal)
  }

  /**
   * Refuse the send when the target's composer already holds unsent text.
   *
   * The paste lands wherever the composer cursor is and Enter submits the whole row, so a
   * user's half-typed draft would ship glued to the prompt (#16289). Only agents whose
   * composer can be read are checked; a screen that cannot be read is unknown, never a
   * refusal, so an unreadable host keeps working rather than blocking every send.
   *
   * A composer holding exactly `prompt` is exempt: that text is the agent's own, not a user's.
   * It is either a held paste this chain's resubmit layer exists to re-send, or the echo #38401
   * watches for to press Enter early, and refusing it would shadow both. Judged by that same
   * `isCompleteAgentPromptDraft`, so "shows the prompt" means one thing across the two features;
   * anything short of the whole prompt — a half-typed draft (#16289) — still refuses.
   *
   * @param prompt The raw text about to be pasted, when the caller knows it. Absent means no
   * exemption: an unidentified send refuses over any draft, exactly as before.
   * @throws AgentPromptPendingInputError carrying the draft, for the caller to report as
   * `refusedReason: 'pending-input'`.
   */
  protected async assertNoPendingComposerInput(
    ptyId: string,
    prompt?: string,
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

  /**
   * The renderer's own view of the composer, when it holds text the provider frame does not.
   *
   * Only provider-preferred ptys consult it. For those, evidence is a frame serialized by the
   * pty's provider, and being current in the output sequence does not make it current with the
   * renderer: a keystroke echoed locally is on screen before it round-trips. Everything else
   * already reads the ordered host emulator, which cannot lag that way.
   *
   * This can only ever ADD a refusal. Returning `null` means "nothing to add here", never
   * "there is no draft", so a renderer that is empty, unmounted or unreadable leaves the
   * provider path to decide exactly as before. The cost is the other direction: renderer-local
   * echo that the agent never accepted (#12358) can refuse a send that would have been safe —
   * loud and non-destructive, which is the side to err on for a guard whose whole job is to
   * never submit over a user's draft.
   */
  private async readRendererComposerDraft(ptyId: string): Promise<string | null> {
    if (!this.providerSnapshotPreferredPtys.has(ptyId)) {
      return null
    }
    const rendererState = await this.readRendererVisibleSnapshotLines(ptyId)
    return rendererState.draft?.trim() ? rendererState.draft : null
  }

  /**
   * Read the composer's unsent text, or `null` when there is none to refuse over.
   *
   * A provider frame is discarded when output advanced past it — which is exactly what a
   * user's keystroke echo does — so a pty served by provider snapshots retries briefly
   * before giving up. Giving up returns `null`: absent evidence is not a draft.
   */
  private async readComposerDraft(ptyId: string, signal?: AbortSignal): Promise<string | null> {
    const attempts = this.providerSnapshotPreferredPtys.has(ptyId)
      ? COMPOSER_DRAFT_READ_ATTEMPTS
      : 1
    for (let attempt = 0; ; attempt += 1) {
      assertAgentPromptRequestActive(signal)
      const rendererDraft = await this.readRendererComposerDraft(ptyId)
      if (rendererDraft !== null) {
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
