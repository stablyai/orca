import { OrcaRuntimeWithGeneratedInputAdmission } from './terminal-generated-input-admission'
import type {
  AgentPromptExpectedBinding,
  RuntimeAgentPromptWriteOptions
} from '../../runtime-terminal-contracts'
import { isHeldAgentPromptDraft } from '../../../../shared/agent-launch/startup/agent-prompt-injection'
import type { AgentPromptActivity } from '../../agent-prompt-submission-verification'
import {
  isAgentPromptStalledError,
  verifyAgentPromptSubmission
} from '../../agent-prompt-submission-verification'
import { TUI_AGENT_CONFIG } from '../../../../shared/agent-launch/catalog/tui-agent-config'
import { waitForAgentPromptPromise } from '../../orca-runtime-core'

type HeldAgentPrompt = {
  baseline: AgentPromptActivity
  readActivity: () => AgentPromptActivity
  prompt: string | undefined
  heldBudgetMs: number
  /** The operation's deadline; no retry outlives it. */
  deadline: number
  /** The operation's recheck before each retry; false skips it. */
  admit: () => Promise<boolean>
  /** The retry's Enter through the operation's last synchronous check; throws when refused. */
  write: () => void
}

export abstract class OrcaRuntimeWithResubmitHeldAgentPrompt extends OrcaRuntimeWithGeneratedInputAdmission {
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
    // Retries share the operation's deadline and abort; none starts a fresh budget.
    const deadline = Math.min(Date.now() + held.heldBudgetMs, held.deadline)
    const signal = options.signal
    let resubmits = 0
    let gatedResubmits = 0
    try {
      do {
        const waitMs = Math.min(
          blind ? retryDelayMs : Math.min(retryDelayMs, deadline - Date.now()),
          held.deadline - Date.now()
        )
        if (await agentPromptSettledWithin(held, Math.max(0, waitMs), signal)) {
          return resubmits
        }
        if (signal?.aborted || Date.now() >= held.deadline) {
          return resubmits
        }
        this.assertAgentPromptGeneration(ptyId, generation)
        // Retry only our prompt: Enter could submit user text or answer an overlay.
        const holdsPrompt = async (): Promise<boolean> =>
          prompt !== undefined &&
          isHeldAgentPromptDraft(
            (await waitForAgentPromptPromise(this.readCurrentTerminalWaitScreen(ptyId), signal))
              ?.draft,
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
        if (!(await held.admit())) {
          return resubmits
        }
        // Recheck after yielding: read the screen before the synchronous deadline/turn checks to avoid stale writes.
        if (!blind && (!(await holdsPrompt()) || Date.now() >= deadline)) {
          return resubmits
        }
        if (await agentPromptSettledWithin(held, 0, signal)) {
          return resubmits
        }
        held.write()
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
