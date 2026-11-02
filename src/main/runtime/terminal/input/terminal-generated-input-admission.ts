import {
  GENERATED_AGENT_INPUT_QUIET_MS,
  GENERATED_AGENT_INPUT_TIMEOUT_MS,
  signalAllowsCompatibilityEvidence,
  waitForGeneratedAgentInput,
  type GeneratedInputIntent
} from '../../../../shared/generated-agent-input-readiness'
import type { DraftPasteReadySignal } from '../../../../shared/tui-agent-config'
import type { RuntimeAgentPromptWriteOptions } from '../../runtime-terminal-contracts'
import {
  admitsGeneratedInput,
  screenRefusesGeneratedInput,
  type GeneratedInputScreen
} from '../../../../shared/generated-agent-input-admission'
import { showsAgentComposer } from '../../../../shared/agent-input-dialog'
import { resolvePasteReadySignal } from '../../../../shared/draft-paste-ready-scanner'
import { showsOpenCodeAgentRow } from '../../../../shared/opencode-agent-row-scanner'
import { isTuiAgent, TUI_AGENT_CONFIG } from '../../../../shared/tui-agent-config'
import type { TuiAgent } from '../../../../shared/tui-agent'
import {
  isAgentForegroundWrapperProcess,
  isExpectedAgentProcess
} from '../../../../shared/agent-process-recognition'
import { generatedInputAgentName } from '../../../../shared/generated-agent-input-notice'
import { isKnownReadyPromptBody } from '../../terminal-wait-detection'
import { AGENT_PROMPT_POST_PASTE_SUBMIT_DELAY_MS } from '../../../../shared/agent-prompt-injection'
import { OrcaRuntimeWithTitlelessPaneAgentIdentity } from '../wait/titleless-pane-agent-identity'
import { GeneratedAgentInputNotices } from '../../generated-agent-input-notices'
import { assertAgentPromptRequestActive } from '../../orca-runtime-core'

/** Resolves with `fallback` once the operation's deadline passes, so no read outlives it. */
export function boundedByDeadline<T>(read: Promise<T>, deadline: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    read.finally(() => clearTimeout(timer)),
    new Promise<T>((resolve) => {
      timer = setTimeout(() => resolve(fallback), Math.max(0, deadline - Date.now()))
    })
  ])
}

// Enter's own admission read and write fit inside this much of the remaining budget.
const ENTER_COMMIT_MARGIN_MS = 50

export type GeneratedInputWait = {
  agent: TuiAgent | null
  deadline: number
  submit: boolean
  intent: GeneratedInputIntent
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

  /** The caught-up host grid, else the current provider screen; null while a model this host
   *  holds has not caught up, 'unknown' when it holds none to observe. */
  protected async readGeneratedInputScreen(ptyId: string): Promise<GeneratedInputScreen> {
    const caughtUp = this.readCaughtUpRuledScreen(ptyId)
    if (caughtUp) {
      return caughtUp
    }
    const screen = await this.readCurrentTerminalWaitScreen(ptyId)
    if (screen) {
      return { lines: screen.lines, alternateScreen: screen.isAlternateScreen }
    }
    // The live grid, even a chunk behind, still shows a dialog it has painted; the write's own
    // synchronous check reads the caught-up grid again.
    const live = this.readLiveTerminalScreenLines(ptyId)
    if (live) {
      return {
        lines: live,
        alternateScreen: this.headlessTerminals.get(ptyId)?.emulator.isAlternateScreen === true
      }
    }
    return this.headlessTerminals.has(ptyId) || this.providerSnapshotPreferredPtys.has(ptyId)
      ? null
      : 'unknown'
  }

  /** Immediately before a provider write, with nothing awaited after it: deadline and the caught-up
   *  grid. A grid that lags is left to the awaited recheck just before. */
  protected assertGeneratedInputCommit(
    ptyId: string,
    agent: TuiAgent | null,
    deadline: number,
    typedText?: string,
    enterReserveMs = -1
  ): void {
    const grid = this.readCaughtUpRuledScreen(ptyId)
    // Text is refused up front when the budget left cannot also cover the Enter that follows it.
    const reserve =
      enterReserveMs < 0 ? 0 : AGENT_PROMPT_POST_PASTE_SUBMIT_DELAY_MS + enterReserveMs
    if (
      Date.now() + reserve >= deadline ||
      (grid && screenRefusesGeneratedInput(agent, grid, typedText))
    ) {
      throw this.generatedInputRefusal(ptyId)
    }
  }

  /** The settle wait before Enter ends with room left for Enter's own check and write. */
  protected async withinEnterBudget(deadline: number, settle: Promise<unknown>): Promise<void> {
    await boundedByDeadline(settle, deadline - ENTER_COMMIT_MARGIN_MS, undefined)
  }

  /** A caller's own guard (a foreground read) shares the operation's deadline. */
  protected async withinGeneratedDeadline(
    ptyId: string,
    deadline: number,
    guard: Promise<unknown>
  ): Promise<void> {
    const finished = await boundedByDeadline(
      guard.then(() => true),
      deadline,
      false
    )
    if (!finished) {
      throw this.generatedInputRefusal(ptyId)
    }
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

  /** Current admission; the screen is read after the awaited process read so it is the latest.
   *  Both reads end at the deadline; an unanswered read is no admission. */
  protected async generatedInputAdmitted(
    ptyId: string,
    agent: TuiAgent | null,
    quiet: boolean,
    deadline: number,
    typedText?: string,
    intent: GeneratedInputIntent = 'startup'
  ): Promise<boolean> {
    const generation = this.getPtyLifecycleGeneration(ptyId)
    const process = await boundedByDeadline(this.readGeneratedInputProcess(ptyId), deadline, {
      known: false
    } as const)
    const read = await boundedByDeadline(this.readGeneratedInputScreen(ptyId), deadline, null)
    // A grid that is not readable yet is no blocking evidence for an agent already running.
    const screen = read === null && intent === 'running' ? 'unknown' : read
    return (
      this.getPtyLifecycleGeneration(ptyId) === generation &&
      admitsGeneratedInput({ agent, screen, process, quiet, typedText })
    )
  }

  /** Positive evidence on the current screen, which no consumed startup byte can take away. Idle
   *  rules that settle only after quiet read the waiter's measured quiet, so a late observer of an
   *  idle Codex or OpenCode grid still sees it ready. */
  private async generatedInputComposerVisible(
    ptyId: string,
    agent: TuiAgent | null,
    signal: DraftPasteReadySignal,
    quietMs: number,
    deadline: number
  ): Promise<boolean> {
    const screen = await boundedByDeadline(this.readGeneratedInputScreen(ptyId), deadline, null)
    if (!screen || screen === 'unknown') {
      return false
    }
    const text = screen.lines.join('\n')
    const outputClock = quietMs < GENERATED_AGENT_INPUT_QUIET_MS
    if (isKnownReadyPromptBody(text, agent, () => screen.lines, outputClock)) {
      return true
    }
    const bracketedPaste =
      this.headlessTerminals.get(ptyId)?.emulator.getModes().bracketedPaste === true
    // OpenCode's submit-ready sign, its stream scanner's agent row, read here from the painted grid;
    // it proves a draft can land too.
    if (
      agent !== null &&
      TUI_AGENT_CONFIG[agent].submitPasteReadySignal === 'opencode-agent-row' &&
      bracketedPaste &&
      screen.alternateScreen === true &&
      showsOpenCodeAgentRow(screen.lines)
    ) {
      return true
    }
    // A painted composer counts once the expected agent is proven in front, so a streaming turn
    // still takes input as it did before this gate; a shell prompt glyph never does.
    if (!signalAllowsCompatibilityEvidence(signal) || !bracketedPaste) {
      return false
    }
    const process = await boundedByDeadline(this.readGeneratedInputProcess(ptyId), deadline, {
      known: false
    } as const)
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
        composerReady: async (quietMs) =>
          wait.observedReady === true ||
          (await this.generatedInputComposerVisible(
            ptyId,
            wait.agent,
            signal,
            quietMs,
            wait.deadline
          )),
        accept: async (quiet) =>
          this.getPtyLifecycleGeneration(ptyId) === generation &&
          (await this.generatedInputAdmitted(
            ptyId,
            wait.agent,
            quiet,
            wait.deadline,
            undefined,
            wait.intent
          ))
      },
      signal,
      {
        signal: wait.signal,
        timeoutMs: Math.max(0, wait.deadline - Date.now()),
        intent: wait.intent
      }
    )
  }

  /** Waits until this operation may write, or throws its refusal. */
  protected async admitGeneratedTerminalInput(
    ptyId: string,
    options: Pick<
      RuntimeAgentPromptWriteOptions,
      'submit' | 'generatedAgent' | 'inputDeadline' | 'observedReady' | 'generatedIntent'
    >,
    signal: AbortSignal | undefined
  ): Promise<Omit<GeneratedInputWait, 'signal' | 'observedReady'>> {
    const agent = this.generatedInputAgent(ptyId, options.generatedAgent)
    const deadline = options.inputDeadline ?? Date.now() + GENERATED_AGENT_INPUT_TIMEOUT_MS
    const submit = options.submit !== false
    // A caller that names no intent is sending to an agent already running, as main sent directly.
    const intent = options.generatedIntent ?? 'running'
    const wait = { agent, deadline, submit, intent, signal, observedReady: options.observedReady }
    if (!(await this.waitForGeneratedTerminalInput(ptyId, wait))) {
      // A cancelled caller learns it was cancelled, as before, not that the agent refused.
      assertAgentPromptRequestActive(signal)
      throw this.generatedInputRefusal(ptyId)
    }
    return { agent, deadline, submit, intent }
  }

  generatedInputRefusal(ptyId: string): Error {
    return new GeneratedInputRefusedError(
      `${generatedInputAgentName(this.getPtyAgent(ptyId))} could not take your prompt. Answer any dialog in its terminal, then retry.`
    )
  }
}

export class GeneratedInputRefusedError extends Error {}
