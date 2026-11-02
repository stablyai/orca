import {
  GENERATED_AGENT_INPUT_TIMEOUT_MS,
  signalAllowsCompatibilityEvidence,
  waitForGeneratedAgentInput
} from '../../../../shared/generated-agent-input-readiness'
import type { DraftPasteReadySignal } from '../../../../shared/tui-agent-config'
import type { RuntimeAgentPromptWriteOptions } from '../../runtime-terminal-contracts'
import { admitsGeneratedInput } from '../../../../shared/generated-agent-input-admission'
import { showsAgentComposer } from '../../../../shared/agent-input-dialog'
import { resolvePasteReadySignal } from '../../../../shared/draft-paste-ready-scanner'
import { isTuiAgent, TUI_AGENT_CONFIG } from '../../../../shared/tui-agent-config'
import type { TuiAgent } from '../../../../shared/tui-agent'
import type { RuledScreen } from '../../../../shared/screen-input-veto'
import {
  isAgentForegroundWrapperProcess,
  isExpectedAgentProcess
} from '../../../../shared/agent-process-recognition'
import { generatedInputAgentName } from '../../../../shared/generated-agent-input-notice'
import { isKnownReadyPromptBody } from '../../terminal-wait-detection'
import { OrcaRuntimeWithTitlelessPaneAgentIdentity } from '../wait/titleless-pane-agent-identity'
import { GeneratedAgentInputNotices } from '../../generated-agent-input-notices'

export type GeneratedInputWait = {
  agent: TuiAgent | null
  deadline: number
  submit: boolean
  signal?: AbortSignal
  /** A launch's own readiness wait already saw this composer; still subject to every veto. */
  observedReady?: boolean
}

/** Every generated write is admitted here, on the host that owns the PTY, from its current screen. */
export abstract class OrcaRuntimeWithGeneratedInputAdmission extends OrcaRuntimeWithTitlelessPaneAgentIdentity {
  /** Recovery for detached sends that failed; owned here, beside the admission that refuses them. */
  readonly generatedInputNotices = new GeneratedAgentInputNotices()

  /** A local PTY id names its terminal through the handle the runtime already holds for it. */
  resolveGeneratedInputTarget(ptyId: string): string | null {
    const pty = this.ptysById.get(ptyId)
    return pty ? (this.handleByPtyId.get(ptyId) ?? this.issuePtyHandle(pty)) : null
  }

  /** The PTY's resolved agent wins; the caller's expectation covers a pane not yet identified. */
  protected generatedInputAgent(ptyId: string, expected?: TuiAgent | null): TuiAgent | null {
    const resolved = this.getPtyAgent(ptyId)
    return isTuiAgent(resolved) ? resolved : (expected ?? null)
  }

  /** The caught-up host grid, else the current provider screen; null while neither is current. */
  protected async readGeneratedInputScreen(ptyId: string): Promise<RuledScreen | null> {
    const caughtUp = this.readCaughtUpRuledScreen(ptyId)
    if (caughtUp) {
      return caughtUp
    }
    const screen = await this.readCurrentTerminalWaitScreen(ptyId)
    return screen ? { lines: screen.lines, alternateScreen: screen.isAlternateScreen } : null
  }

  private async readGeneratedInputProcess(ptyId: string) {
    const foreground = await this.ptyController?.getForegroundProcess(ptyId).catch(() => null)
    if (!foreground) {
      return { known: false } as const
    }
    const hasChildProcesses = isAgentForegroundWrapperProcess(foreground)
      ? await (this.ptyController?.hasChildProcesses?.(ptyId) ?? Promise.resolve(false)).catch(
          () => false
        )
      : false
    return { known: true, foreground, hasChildProcesses } as const
  }

  /** Current admission; the screen is read after the awaited process read so it is the latest. */
  protected async generatedInputAdmitted(
    ptyId: string,
    agent: TuiAgent | null,
    quiet: boolean,
    typedText?: string
  ): Promise<boolean> {
    const generation = this.getPtyLifecycleGeneration(ptyId)
    const process = await this.readGeneratedInputProcess(ptyId)
    const screen = await this.readGeneratedInputScreen(ptyId)
    return (
      this.getPtyLifecycleGeneration(ptyId) === generation &&
      admitsGeneratedInput({ agent, screen, process, quiet, typedText })
    )
  }

  /** Positive evidence on the current screen, which no consumed startup byte can take away. */
  private async generatedInputComposerVisible(
    ptyId: string,
    agent: TuiAgent | null,
    signal: DraftPasteReadySignal
  ): Promise<boolean> {
    const screen = await this.readGeneratedInputScreen(ptyId)
    if (!screen) {
      return false
    }
    const text = screen.lines.join('\n')
    if (isKnownReadyPromptBody(text, agent, () => screen.lines, true)) {
      return true
    }
    // A painted composer counts once the expected agent is proven in front, so a streaming turn
    // still takes input as it did before this gate; a shell prompt glyph never does.
    if (
      !signalAllowsCompatibilityEvidence(signal) ||
      this.headlessTerminals.get(ptyId)?.emulator.getModes().bracketedPaste !== true
    ) {
      return false
    }
    const process = await this.readGeneratedInputProcess(ptyId)
    return (
      process.known &&
      agent !== null &&
      isExpectedAgentProcess(process.foreground, TUI_AGENT_CONFIG[agent].expectedProcess) &&
      showsAgentComposer(text)
    )
  }

  /** Wait at the head of the PTY's submission tail; the deadline was fixed when the host accepted. */
  protected waitForGeneratedTerminalInput(
    ptyId: string,
    wait: GeneratedInputWait
  ): Promise<boolean> {
    const generation = this.getPtyLifecycleGeneration(ptyId)
    const config = wait.agent ? TUI_AGENT_CONFIG[wait.agent] : null
    const signal = resolvePasteReadySignal(config, wait.submit)
    return waitForGeneratedAgentInput(
      {
        subscribe: (observe) => this.subscribeToTerminalData(ptyId, observe),
        replay: () => this.recentPtyOutputById.get(ptyId)?.read(),
        bracketedPaste: () =>
          this.headlessTerminals.get(ptyId)?.emulator.getModes().bracketedPaste === true,
        composerReady: async () =>
          wait.observedReady === true ||
          (await this.generatedInputComposerVisible(ptyId, wait.agent, signal)),
        accept: async (quiet) =>
          this.getPtyLifecycleGeneration(ptyId) === generation &&
          (await this.generatedInputAdmitted(ptyId, wait.agent, quiet))
      },
      signal,
      { signal: wait.signal, timeoutMs: Math.max(0, wait.deadline - Date.now()) }
    )
  }

  /** Waits until this operation may write, or throws its refusal. */
  protected async admitGeneratedTerminalInput(
    ptyId: string,
    options: Pick<
      RuntimeAgentPromptWriteOptions,
      'submit' | 'generatedAgent' | 'inputDeadline' | 'observedReady'
    >,
    signal: AbortSignal | undefined
  ): Promise<{ agent: TuiAgent | null; deadline: number; submit: boolean }> {
    const agent = this.generatedInputAgent(ptyId, options.generatedAgent)
    const deadline = options.inputDeadline ?? Date.now() + GENERATED_AGENT_INPUT_TIMEOUT_MS
    const submit = options.submit !== false
    const wait = { agent, deadline, submit, signal, observedReady: options.observedReady }
    if (!(await this.waitForGeneratedTerminalInput(ptyId, wait))) {
      throw this.generatedInputRefusal(ptyId)
    }
    return { agent, deadline, submit }
  }

  generatedInputRefusal(ptyId: string): Error {
    return new GeneratedInputRefusedError(
      `${generatedInputAgentName(this.getPtyAgent(ptyId))} could not take your prompt. Answer any dialog in its terminal, then retry.`
    )
  }
}

export class GeneratedInputRefusedError extends Error {}
