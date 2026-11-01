import { waitForGeneratedAgentInput } from '../../../../shared/generated-agent-input-readiness'
import { resolvePasteReadySignal } from '../../../../shared/draft-paste-ready-scanner'
import { isTuiAgent } from '../../../../shared/tui-agent-config'
import {
  isExpectedAgentProcess,
  isAgentForegroundWrapperProcess,
  recognizeAgentProcess
} from '../../../../shared/agent-process-recognition'
import { isShellProcess, getAgentLabel } from '../../../../shared/agent-detection'
import {
  detectTerminalWaitBlockedReason,
  isKnownReadyPromptBody
} from '../../terminal-wait-detection'
import { OrcaRuntimeWithTitlelessPaneAgentIdentity } from '../wait/titleless-pane-agent-identity'
import { readScreenInputVeto } from '../../screen-input-veto'
import type {
  AgentPromptExpectedBinding,
  RuntimeAgentPromptWriteOptions
} from '../../runtime-terminal-contracts'
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

export abstract class OrcaRuntimeWithResubmitHeldAgentPrompt extends OrcaRuntimeWithTitlelessPaneAgentIdentity {
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

  async generatedInputScreenIsClear(ptyId: string, deadline = Infinity): Promise<boolean> {
    const generation = this.getPtyLifecycleGeneration(ptyId)
    const foreground = await this.ptyController?.getForegroundProcess(ptyId)
    if (isShellProcess(foreground ?? '')) {
      return false
    }
    const screen =
      this.readCaughtUpRuledScreen(ptyId) ?? (await this.readCurrentTerminalWaitScreen(ptyId))
    const resolved = this.getPtyAgent(ptyId)
    const agent = isTuiAgent(resolved) ? resolved : null
    return (
      screen != null &&
      this.getPtyLifecycleGeneration(ptyId) === generation &&
      readScreenInputVeto(agent, () => ({
        lines: screen.lines,
        alternateScreen:
          'alternateScreen' in screen ? screen.alternateScreen : screen.isAlternateScreen
      })) !== true &&
      detectTerminalWaitBlockedReason(screen.lines.join('\n')) === null &&
      Date.now() < deadline
    )
  }

  async waitForGeneratedTerminalInput(
    handle: string,
    signal?: AbortSignal,
    timeoutMs?: number
  ): Promise<boolean> {
    const ptyId = this.getTerminalPtyIdForHandle(handle)
    if (!ptyId) {
      return false
    }
    const generation = this.getPtyLifecycleGeneration(ptyId)
    const resolved = this.getPtyAgent(ptyId)
    const agent = isTuiAgent(resolved) ? resolved : null
    const config = agent ? TUI_AGENT_CONFIG[agent] : null
    return waitForGeneratedAgentInput(
      {
        subscribe: (observe) => this.subscribeToTerminalData(ptyId, observe),
        replay: () => this.recentPtyOutputById.get(ptyId)?.read(),
        composerReady: async () => {
          const screen =
            this.readCaughtUpRuledScreen(ptyId) ?? (await this.readCurrentTerminalWaitScreen(ptyId))
          return (
            screen != null &&
            isKnownReadyPromptBody(screen.lines.join('\n'), agent, () => screen.lines, true)
          )
        },
        accept: async (quiet) => {
          if (!(await this.generatedInputScreenIsClear(ptyId))) {
            return false
          }
          const foreground = await this.ptyController?.getForegroundProcess(ptyId)
          if (isShellProcess(foreground ?? '')) {
            return false
          }
          const expectedInFront = config
            ? isExpectedAgentProcess(foreground, config.expectedProcess)
            : recognizeAgentProcess(foreground) !== null
          if (quiet && !expectedInFront) {
            if (
              !isAgentForegroundWrapperProcess(foreground ?? '') ||
              !(await this.ptyController?.hasChildProcesses?.(ptyId))
            ) {
              return false
            }
          }
          return (
            this.getTerminalPtyIdForHandle(handle) === ptyId &&
            this.getPtyLifecycleGeneration(ptyId) === generation &&
            (await this.generatedInputScreenIsClear(ptyId))
          )
        }
      },
      resolvePasteReadySignal(config, true),
      { signal, timeoutMs, requireComposerMarker: Boolean(config?.composerReadyCaptures?.length) }
    )
  }

  generatedInputRefusal(ptyId: string): Error {
    const agent = this.getPtyAgent(ptyId)
    return new Error(
      `${agent ? getAgentLabel(agent) : 'The agent'} could not take your prompt. Answer any dialog in its terminal, then retry.`
    )
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
        if (!(await this.generatedInputScreenIsClear(ptyId))) {
          return resubmits
        }
        // Recheck after yielding: read the screen before the synchronous deadline/turn checks to avoid stale writes.
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
