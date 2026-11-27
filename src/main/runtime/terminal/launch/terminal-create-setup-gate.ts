import type { TuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent'
import type {
  RuntimeTerminalCreate,
  SETUP_AGENT_GATE
} from '../../../../shared/terminal/runtime/runtime-terminal-create-contract'
import { recordAgentStartTelemetry } from '../../../ipc/pty/pane/spawn-telemetry'
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
    const record = (command: string | undefined): TuiAgent | null => {
      const agent = recordTerminalLaunchMetadata(pty, result, launch, command)
      this.watchLaunchedAgent(pty, agent)
      if (!launch.adoptedStablePane) {
        this.rememberSavedTerminalLaunchResult(result.id, result)
      }
      return agent
    }
    if (
      !gatedStartup ||
      launch.adoptedStablePane ||
      result.agentProgramBlocked ||
      result.agentResumeRefused
    ) {
      const agent = record(opts.command)
      if (gatedStartup) {
        return { started: this.observeStartupDraftGate(pty.ptyId, true), blocked: true }
      }
      if (agent) {
        this.observeVerifiedReplacementLaunch(pty.ptyId, agent)
      }
      return undefined
    }
    const signal = this.getPtyLifecycleSignal(pty.ptyId)
    const gate = this.observeStartupDraftGate(pty.ptyId)
    void gate
      .then((started) => {
        if (started && !signal.aborted) {
          record(gatedStartup)
          if (opts.telemetry) {
            recordAgentStartTelemetry(opts.telemetry)
          }
        }
      })
      .catch(console.warn)
    return { started: gate }
  }
}
