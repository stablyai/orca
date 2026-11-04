import {
  screenRefusesGeneratedInput,
  type GeneratedInputScreen
} from '../../../../shared/generated-agent-input-admission'
import type { GeneratedInputEvidence } from '../../../../shared/generated-input-readiness-evaluation'
import { isTuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent-config'
import type { TuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent'
import { isAgentForegroundWrapperProcess } from '../../../../shared/agent-process-recognition'
import { generatedInputAgentName } from '../../../../shared/generated-agent-input-notice'
import { AGENT_PROMPT_POST_PASTE_SUBMIT_DELAY_MS } from '../../../../shared/agent-launch/startup/agent-prompt-injection'
import { OrcaRuntimeWithTitlelessPaneAgentIdentity } from '../wait/titleless-pane-agent-identity'
import { GeneratedAgentInputNotices } from '../../generated-agent-input-notices'
import { GeneratedInputRefusedError } from './generated-input-refused-error'

/** The PTY host's facts and last synchronous check for the shared generated-input operation. */
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

  protected async readGeneratedInputProcess(ptyId: string) {
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

  /** The host's facts for one generated write: current grid (or null while the model catches
   *  up, 'unknown' with no model), foreground process and paste mode. A replaced PTY is gone. */
  protected async readGeneratedInputEvidence(
    ptyId: string,
    generation: number
  ): Promise<GeneratedInputEvidence> {
    const process = await this.readGeneratedInputProcess(ptyId)
    // The screen is read after the awaited process read so it is the latest.
    const screen = await this.readGeneratedInputScreen(ptyId)
    if (this.getPtyLifecycleGeneration(ptyId) !== generation) {
      throw new Error('terminal_handle_stale')
    }
    const modes = this.headlessTerminals.get(ptyId)?.emulator.getModes()
    return { screen, process, bracketedPaste: modes ? modes.bracketedPaste : null }
  }

  generatedInputRefusal(ptyId: string): Error {
    return new GeneratedInputRefusedError(
      `${generatedInputAgentName(this.getPtyAgent(ptyId))} could not take your prompt. Answer any dialog in its terminal, then retry.`
    )
  }
}
