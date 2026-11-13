import { OrcaRuntimeWithTitlelessPaneAgentIdentity } from '../wait/titleless-pane-agent-identity'
import type { RuntimeAgentPromptWriteOptions } from './agent-prompt-write-options'
import {
  AGENT_PROMPT_SUBMIT,
  isHeldAgentPromptDraft
} from '../../../../shared/agent-launch/startup/agent-prompt-injection'
import type { AgentPromptActivity } from './agent-prompt-submission-verification'
import {
  isAgentPromptStalledError,
  verifyAgentPromptSubmission
} from './agent-prompt-submission-verification'
import { TUI_AGENT_CONFIG } from '../../../../shared/agent-launch/catalog/tui-agent-config'
import { watchHeldLaunchpadPrompt } from './held-launchpad-prompt-watch'

type HeldAgentPrompt = {
  baseline: AgentPromptActivity
  readActivity: () => AgentPromptActivity
  prompt: string | undefined
  heldBudgetMs: number
}

export abstract class OrcaRuntimeWithResubmitHeldAgentPrompt extends OrcaRuntimeWithTitlelessPaneAgentIdentity {
  /** Retry blind Enter and drafts held by Windows input-record pastes or unopened dsh launchpads; retries cannot fail a submitted prompt.
   *  A dsh launchpad still holding the prompt at the budget's end hands it to a detached watch. */
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
    let expiredHolding = false
    try {
      do {
        const waitMs = blind ? retryDelayMs : Math.min(retryDelayMs, deadline - Date.now())
        if (await agentPromptSettledWithin(held, Math.max(0, waitMs), options.signal)) {
          return resubmits
        }
        this.assertAgentPromptGeneration(ptyId, generation)
        // Retry only our prompt: Enter could submit user text or answer an overlay.
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
        // Recheck after yielding: read the screen before the synchronous deadline/turn checks to avoid stale writes.
        if (!blind && !(await holdsPrompt())) {
          return resubmits
        }
        if (!blind && Date.now() >= deadline) {
          expiredHolding = true
          break
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
      expiredHolding ||= gated
    } catch {
      // Why: a refused retry leaves the first Enter's verdict to the verification that follows.
      expiredHolding = false
    }
    if (expiredHolding && readsLaunchDraft && prompt !== undefined) {
      this.watchHeldLaunchpadPrompt(ptyId, generation, options, held, prompt, {
        retryDelayMs,
        absorbedEnters: 1 + resubmits
      })
    }
    return resubmits
  }

  private readonly heldLaunchpadPromptWatches = new Map<string, AbortController>()

  /** Detached from the send: its caller's wait and prompt lock end with the in-band budget. */
  private watchHeldLaunchpadPrompt(
    ptyId: string,
    generation: number,
    options: RuntimeAgentPromptWriteOptions,
    held: HeldAgentPrompt,
    prompt: string,
    args: { retryDelayMs: number; absorbedEnters: number }
  ): void {
    this.heldLaunchpadPromptWatches.get(ptyId)?.abort()
    const stop = new AbortController()
    this.heldLaunchpadPromptWatches.set(ptyId, stop)
    void watchHeldLaunchpadPrompt(
      {
        isLive: () => {
          try {
            this.assertAgentPromptGeneration(ptyId, generation)
            return !this.isPtyStopRequested(ptyId)
          } catch {
            return false
          }
        },
        readLastInputAt: () => this.terminalRunFacts.readLastInputAt(ptyId),
        settled: () => agentPromptSettledWithin(held, 0, stop.signal),
        holdsPrompt: async (absorbedEnters) =>
          isHeldAgentPromptDraft(
            (await this.readCurrentTerminalWaitScreen(ptyId))?.draft,
            prompt,
            absorbedEnters
          ),
        pressEnter: () =>
          this.ptyController?.write(ptyId, AGENT_PROMPT_SUBMIT, options.inputKind) === true
      },
      { ...args, signal: stop.signal }
    )
      .catch(() => 0)
      .finally(() => {
        if (this.heldLaunchpadPromptWatches.get(ptyId) === stop) {
          this.heldLaunchpadPromptWatches.delete(ptyId)
        }
      })
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
