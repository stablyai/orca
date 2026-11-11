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

/** dsh's launchpad can outlast the fixed submit budget on a busy host; keep pressing while it still holds our prompt. */
const DSH_LAUNCHPAD_SUBMIT_EXTENSION_MS = 4 * 60_000

type HeldAgentPrompt = {
  baseline: AgentPromptActivity
  readActivity: () => AgentPromptActivity
  prompt: string | undefined
  heldBudgetMs: number
}

export abstract class OrcaRuntimeWithResubmitHeldAgentPrompt extends OrcaRuntimeWithTitlelessPaneAgentIdentity {
  /** Retry blind Enter and drafts held by Windows input-record pastes or unopened dsh launchpads; retries cannot fail a submitted prompt. */
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
    const retryStartedAt = Date.now()
    let deadline = retryStartedAt + held.heldBudgetMs
    // Worker dispatches stay inside the fixed budget: federated worker-start attaches for at most
    // 100 s, so a longer wait would let the home dispatch report outcome_unknown mid-retry.
    const launchpadExtensionMs =
      readsLaunchDraft && options.inputKind !== 'orchestration'
        ? DSH_LAUNCHPAD_SUBMIT_EXTENSION_MS
        : 0
    // Measured from the retry start, so the cap is absolute rather than base budget plus extension.
    const hardDeadline = Math.max(deadline, retryStartedAt + launchpadExtensionMs)
    let resubmits = 0
    let gatedResubmits = 0
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
        if (!blind) {
          // dsh paints its launchpad before the session can submit; a busy host can outlast the fixed
          // budget, so keep pressing while the launchpad still holds our prompt (#38131).
          if (!(await holdsPrompt())) {
            return resubmits
          }
          if (Date.now() >= deadline) {
            if (launchpadExtensionMs === 0 || Date.now() >= hardDeadline) {
              return resubmits
            }
            deadline = hardDeadline
          }
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
