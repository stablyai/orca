import { OrcaRuntimeWithResolveAuthoritativeTerminalWaitPermission } from '../wait/terminal-wait-permission'
import type { RuntimeAgentPromptWriteOptions } from '../../runtime-terminal-contracts'
import {
  AGENT_PROMPT_SUBMIT,
  isHeldAgentPromptDraft
} from '../../../../shared/agent-prompt-injection'
import type { AgentPromptActivity } from '../../agent-prompt-submission-verification'
import {
  isAgentPromptStalledError,
  verifyAgentPromptSubmission
} from '../../agent-prompt-submission-verification'
import { TUI_AGENT_CONFIG } from '../../../../shared/tui-agent-config'

type HeldAgentPrompt = {
  baseline: AgentPromptActivity
  readActivity: () => AgentPromptActivity
  prompt: string | undefined
  heldBudgetMs: number
}

export abstract class OrcaRuntimeWithResubmitHeldAgentPrompt extends OrcaRuntimeWithResolveAuthoritativeTerminalWaitPermission {
  /**
   * Presses Enter again for agents that can drop the first one (`submitRetryDelayMs`): once blind
   * into a launch composer drawn before Enter is live, and while the composer still shows this
   * prompt: on Windows, which an input-record paste burst kept as a newline, or on a dsh launchpad
   * whose session has not opened. Best effort: it never fails a prompt the first Enter submitted.
   */
  protected async resubmitHeldAgentPrompt(
    ptyId: string,
    generation: number,
    options: RuntimeAgentPromptWriteOptions,
    held: HeldAgentPrompt
  ): Promise<number> {
    const agent = this.getPtyAgent(ptyId)
    const retryDelayMs = agent ? TUI_AGENT_CONFIG[agent]?.submitRetryDelayMs : undefined
    const prompt = held.prompt
    const gated = held.heldBudgetMs > 0 && prompt !== undefined
    // Why: the draft reader knows dsh's launchpad, which its first-run guide covers once ready.
    const readsLaunchDraft = agent === 'dsh'
    let blind = options.composerReady === true && !readsLaunchDraft
    if (retryDelayMs === undefined || (!blind && !gated)) {
      return 0
    }
    const deadline = Date.now() + held.heldBudgetMs
    let resubmits = 0
    let gatedResubmits = 0
    try {
      do {
        const waitMs = blind ? retryDelayMs : Math.min(retryDelayMs, deadline - Date.now())
        if (await agentPromptSettledWithin(held, Math.max(0, waitMs), options.signal)) {
          return resubmits
        }
        this.assertAgentPromptGeneration(ptyId, generation)
        // Why our prompt only: a rotating placeholder, a question overlay or the user's own text
        // also reads as a draft, and Enter would submit or answer it.
        const holdsPrompt = async (): Promise<boolean> =>
          prompt !== undefined &&
          isHeldAgentPromptDraft(
            (await this.readCurrentTerminalWaitScreen(ptyId))?.draft,
            prompt,
            1 + resubmits
          )
        if (!blind && !(await holdsPrompt())) {
          // Gone after a gated retry means it was taken; before one, the burst may still be read.
          // dsh paints its draft at once, so gone means it was taken or the guide covers it.
          if (gatedResubmits > 0 || readsLaunchDraft) {
            return resubmits
          }
          continue
        }
        await options.beforeWrite?.(ptyId)
        // Why again: the guard can yield while the agent takes the prompt, opens an approval or
        // the user types, so the decision is remade right before the write — the slow screen
        // read first, then the deadline and turn checks with nothing awaited after them.
        if (!blind && (!(await holdsPrompt()) || Date.now() >= deadline)) {
          return resubmits
        }
        if (await agentPromptSettledWithin(held, 0, options.signal)) {
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
