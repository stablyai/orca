import type {
  RuntimeTerminalCreate,
  SETUP_AGENT_GATE
} from '../../../../shared/terminal/runtime/runtime-terminal-create-contract'
import { recordAgentStartTelemetry } from '../../../ipc/pty/pane/spawn-telemetry'
import { waitForWorktreeSetupGate } from '../../workspaces/startup/worktree-setup-gate'
import type { RuntimePtyWorktreeRecord } from '../records/runtime-terminal-state-records'
import { OrcaRuntimeWithTerminalCreateDeduplication } from './terminal-create-deduplication'
import type { TerminalCreateOptions } from './terminal-create-options'
import {
  recordTerminalLaunchMetadata,
  type resolveTerminalLaunchResult
} from './terminal-launch-result'

export abstract class OrcaRuntimeWithCreateTerminalSetupGate extends OrcaRuntimeWithTerminalCreateDeduplication {
  protected recordCreatedTerminalLaunch(
    pty: RuntimePtyWorktreeRecord,
    result: Parameters<typeof recordTerminalLaunchMetadata>[1],
    launch: ReturnType<typeof resolveTerminalLaunchResult>,
    opts: TerminalCreateOptions,
    gatedStartup: string | undefined
  ): RuntimeTerminalCreate[typeof SETUP_AGENT_GATE] {
    const record = (command: string | undefined): void => {
      this.watchLaunchedAgent(pty, recordTerminalLaunchMetadata(pty, result, launch, command))
      if (!launch.adoptedStablePane) {
        this.rememberSavedTerminalLaunchResult(result.id, result)
      }
    }
    if (
      !gatedStartup ||
      launch.adoptedStablePane ||
      result.agentProgramBlocked ||
      result.agentResumeRefused
    ) {
      record(opts.command)
      return gatedStartup
        ? {
            outcome: Promise.resolve(result.agentProgramBlocked ? 'blocked' : 'failed'),
            blocked: true
          }
        : undefined
    }
    const signal = this.getPtyLifecycleSignal(pty.ptyId)
    const gate = waitForWorktreeSetupGate(this.getWorktreeStartupReadinessHost(), pty.ptyId, signal)
    void gate
      .then((outcome) => {
        if (outcome === 'started' && !signal.aborted) {
          record(gatedStartup)
          if (opts.telemetry) {
            recordAgentStartTelemetry(opts.telemetry)
          }
        }
      })
      .catch(console.warn)
    return { outcome: gate }
  }
}
