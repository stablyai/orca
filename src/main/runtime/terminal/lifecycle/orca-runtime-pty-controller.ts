import { OrcaRuntimeWithGetRuntimeId } from '../../workspaces/session-hosts/get-runtime-id'
import type { RuntimePtyController } from './runtime-pty-controller-contract'
import type {
  AutomaticWorkResumeOutcome,
  AutomaticWorkStatus
} from '../../../../shared/terminal/pty/admission/spawn-admission-contract'
import type {
  HostTerminalUsage,
  TerminalLimitStatus,
  TerminalLimitUpdate
} from '../../../../shared/terminal/runtime-policy/terminal-limit-policy'

export abstract class OrcaRuntimeWithPtyController extends OrcaRuntimeWithGetRuntimeId {
  setPtyController(controller: RuntimePtyController | null): void {
    // Why: CLI terminal writes must go through the main-owned PTY registry
    // instead of tunneling back through renderer IPC, or live handles could
    // drift from the process they are supposed to control during reloads.
    if (this.ptyController !== controller) {
      this.ptyControllerGeneration++
      this.ptyController = controller
    }
  }

  /** Null when the local terminal owner has no fork gate (in-process fallback, older daemon). */
  async terminalLimit(update?: TerminalLimitUpdate): Promise<TerminalLimitStatus | null> {
    return (await this.ptyController?.terminalLimit?.(update)) ?? null
  }

  async hostTerminalUsage(): Promise<HostTerminalUsage | null> {
    return (await this.ptyController?.hostTerminalUsage?.()) ?? null
  }

  async getAutomaticWorkStatus(): Promise<AutomaticWorkStatus | null> {
    return (await this.ptyController?.getAutomaticWorkStatus?.()) ?? null
  }

  async resumeAutomaticWork(): Promise<AutomaticWorkResumeOutcome> {
    return (await this.ptyController?.resumeAutomaticWork?.()) ?? null
  }
}
