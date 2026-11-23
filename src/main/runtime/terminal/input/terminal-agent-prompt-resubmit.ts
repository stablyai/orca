import { OrcaRuntimeWithTitlelessPaneAgentIdentity } from '../wait/titleless-pane-agent-identity'
import type { RuntimeAgentPromptWriteOptions } from './agent-prompt-write-options'
import {
  AGENT_PROMPT_SUBMIT,
  isHeldAgentPromptDraft,
  openCodeCollapsesPaste
} from '../../../../shared/agent-launch/startup/agent-prompt-injection'
import type { AgentPromptActivity } from './agent-prompt-submission-verification'
import {
  isAgentPromptStalledError,
  verifyAgentPromptSubmission
} from './agent-prompt-submission-verification'
import { TUI_AGENT_CONFIG } from '../../../../shared/agent-launch/catalog/tui-agent-config'
import { readOpenCodeComposerDraft } from '../../../../shared/terminal/input/opencode-composer'
import type { TerminalAgent } from '../../../../shared/agent-status/identity/terminal-agent'
import { readClippedCodexComposerDraft } from '../../../../shared/terminal/input/terminal-composer-draft'

/** How often a held prompt is re-read when the agent sets no blind-retry delay. */
const HELD_PROMPT_RECHECK_MS = 1000

type HeldAgentPrompt = {
  baseline: AgentPromptActivity
  readActivity: () => AgentPromptActivity
  prompt: string | undefined
  heldBudgetMs: number
  allowMixedPaste?: boolean
  canResubmit?: () => boolean
}

/** Whether an OpenCode send keeps retrying past its resolution: OpenCode inserts a paste it
 *  collapses into `[Pasted ~N lines]` asynchronously, so an Enter that beats it leaves the prompt
 *  unsent (#45760). */
function armsOpenCodePasteRetry(held: HeldAgentPrompt): boolean {
  return (
    // Why: a busy OpenCode steers or queues the send with no new turn edge to end the wait on.
    held.baseline.status !== 'working' &&
    held.prompt !== undefined &&
    openCodeCollapsesPaste(held.prompt)
  )
}

export abstract class OrcaRuntimeWithResubmitHeldAgentPrompt extends OrcaRuntimeWithTitlelessPaneAgentIdentity {
  /** The extra Enters a send waits for; OpenCode's paste retry runs on after the send instead. */
  protected resubmitHeldAgentPromptForSend(
    ptyId: string,
    generation: number,
    options: RuntimeAgentPromptWriteOptions,
    held: HeldAgentPrompt
  ): Promise<number> {
    const agent = this.getPtyAgent(ptyId)
    if (agent !== 'opencode' && agent !== 'opencode2') {
      return this.resubmitHeldAgentPrompt(ptyId, generation, agent, options, held)
    }
    if (armsOpenCodePasteRetry(held)) {
      // Why: its first recheck is a second away, so it must not delay the send's acceptance.
      const retry = this.resubmitHeldAgentPrompt(ptyId, generation, agent, options, held).then(
        () => undefined,
        () => undefined
      )
      options.onHeldPromptRetry?.(retry)
    }
    return Promise.resolve(0)
  }

  /** Retry blind Enter and drafts held by Windows input-record pastes, unopened dsh launchpads or
   *  OpenCode's async paste; retries cannot fail a submitted prompt. */
  private async resubmitHeldAgentPrompt(
    ptyId: string,
    generation: number,
    agent: TerminalAgent | null,
    options: RuntimeAgentPromptWriteOptions,
    held: HeldAgentPrompt
  ): Promise<number> {
    const retryDelayMs = agent ? TUI_AGENT_CONFIG[agent]?.submitRetryDelayMs : undefined
    const prompt = held.prompt
    const openCode = agent === 'opencode' || agent === 'opencode2'
    const gated = held.heldBudgetMs > 0 && prompt !== undefined
    // Why: the draft reader knows dsh's launchpad, which its first-run guide covers once ready.
    const readsLaunchDraft = agent === 'dsh'
    let blind = options.composerReady === true && !readsLaunchDraft && retryDelayMs !== undefined
    if (!blind && !gated) {
      return 0
    }
    const recheckMs = retryDelayMs ?? HELD_PROMPT_RECHECK_MS
    // Why one recheck past the budget: the burst can end just before it, and a held prompt still needs Enter then.
    const deadline = Date.now() + held.heldBudgetMs + recheckMs
    let resubmits = 0
    let gatedResubmits = 0
    try {
      do {
        const waitMs = blind ? recheckMs : Math.min(recheckMs, deadline - Date.now())
        if (await agentPromptSettledWithin(held, Math.max(0, waitMs), options.signal)) {
          return resubmits
        }
        this.assertAgentPromptGeneration(ptyId, generation)
        // Retry only our prompt: Enter could submit user text or answer an overlay.
        const holdsPrompt = async (): Promise<boolean> => {
          const draft = await this.readHeldPromptDraft(ptyId, openCode, held.allowMixedPaste)
          return (
            prompt !== undefined &&
            isHeldAgentPromptDraft(
              draft.text,
              prompt,
              1 + resubmits,
              held.allowMixedPaste ? { clipped: draft.clipped } : undefined
            )
          )
        }
        if (!blind && !(await holdsPrompt())) {
          // Gone after a gated retry means it was taken; before one, the burst may still be read.
          // dsh paints its draft at once and OpenCode once a file stat resolves, so gone means
          // it was taken (or dsh's guide covers it).
          if (gatedResubmits > 0 || readsLaunchDraft || openCode) {
            return resubmits
          }
          continue
        }
        await options.beforeWrite?.(ptyId)
        // Recheck after yielding: read the screen before the synchronous deadline/turn checks to avoid stale writes.
        if (!blind && (!(await holdsPrompt()) || Date.now() >= deadline)) {
          return resubmits
        }
        if (await agentPromptSettledWithin(held, 0, options.signal)) {
          return resubmits
        }
        // No await between the last user-input/dialog check and Enter.
        if (held.canResubmit && !held.canResubmit()) {
          return resubmits
        }
        if (!this.ptyController?.write(ptyId, AGENT_PROMPT_SUBMIT, options.inputKind)) {
          return resubmits
        }
        resubmits += 1
        if (blind) {
          blind = false
        } else {
          gatedResubmits += 1
        }
      } while (gated && Date.now() < deadline)
    } catch {
      // Why: a refused retry leaves the first Enter's verdict to the verification that follows.
    }
    return resubmits
  }

  private async readHeldPromptDraft(
    ptyId: string,
    openCode: boolean,
    ownedCodexPaste = false
  ): Promise<{ text: string | undefined; clipped?: boolean }> {
    // Why: this read also catches the emulator up to the latest output.
    const screen = await this.readCurrentTerminalWaitScreen(ptyId)
    if (screen && !screen.draft && ownedCodexPaste) {
      const context = this.readWholeScreenModel(ptyId)?.emulator.getCursorLineContext()
      return { text: readClippedCodexComposerDraft(context ?? null) ?? undefined, clipped: true }
    }
    if (!openCode || !screen) {
      return { text: screen?.draft }
    }
    // Why: OpenCode's composer has no prompt glyph, so read its box from the caught-up grid.
    const context = this.readWholeScreenModel(ptyId)?.emulator.getCursorLineContext()
    return { text: (context && readOpenCodeComposerDraft(context)) ?? undefined }
  }
}

/** True once a turn started, or a permission prompt or new process makes another Enter unsafe. */
async function agentPromptSettledWithin(
  held: HeldAgentPrompt,
  timeoutMs: number,
  signal: AbortSignal | undefined
): Promise<boolean> {
  try {
    await verifyAgentPromptSubmission({
      baseline: held.baseline,
      readActivity: held.readActivity,
      allowOutputEvidence: false,
      timeoutMs,
      signal
    })
    return true
  } catch (error) {
    return !isAgentPromptStalledError(error)
  }
}
