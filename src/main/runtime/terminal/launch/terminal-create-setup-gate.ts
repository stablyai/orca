import {
  SETUP_AGENT_SEQUENCE_STARTUP_COMMAND_ENV,
  SETUP_AGENT_SEQUENCE_STARTUP_SCRIPT_ENV
} from '../../../../shared/agent-launch/startup/setup-agent-sequencing'
import type { TuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent'
import { isTuiAgentEnabled } from '../../../../shared/agent-launch/catalog/tui-agent-selection'
import type { RuntimeTerminalCreate } from '../../../../shared/terminal/runtime/runtime-terminal-create-contract'
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
    handle: string,
    result: Parameters<typeof recordTerminalLaunchMetadata>[1],
    launch: ReturnType<typeof resolveTerminalLaunchResult>,
    opts: TerminalCreateOptions,
    gatedStartup: string | undefined,
    cwd: string
  ): void {
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
      return
    }
    const env = { ...opts.env }
    delete env[SETUP_AGENT_SEQUENCE_STARTUP_COMMAND_ENV]
    delete env[SETUP_AGENT_SEQUENCE_STARTUP_SCRIPT_ENV]
    this.setupStartup.observe({
      worktreeId: pty.worktreeId,
      ptyId: pty.ptyId,
      host: this.getWorktreeStartupReadinessHost(),
      signal: this.getPtyLifecycleSignal(pty.ptyId),
      handle,
      startup: {
        command: gatedStartup,
        env,
        envToDelete: opts.envToDelete,
        cwd,
        title: opts.title,
        launchRuntime: opts.launchRuntime,
        launchAgent: launch.launchAgent,
        launchConfig: opts.launchConfig,
        viewMode: opts.viewMode,
        startupCommandDelivery: opts.startupCommandDelivery,
        telemetry: opts.telemetry
      },
      started: () => {
        record(gatedStartup)
        if (opts.telemetry) {
          recordAgentStartTelemetry(opts.telemetry)
        }
      },
      replay: (terminal, { draft, followup }) => {
        if (draft) {
          this.pasteStartupDraftWhenReady(terminal.handle, draft)
        }
        if (followup) {
          void this.deliverStartupFollowup(terminal.handle, followup, {
            terminalCreation: terminal
          }).catch(console.warn)
        }
      }
    })
  }

  retryBlockedWorktreeStartup(
    worktreeId: string,
    agent: TuiAgent,
    create: (startup: TerminalCreateOptions) => Promise<RuntimeTerminalCreate>
  ): Promise<RuntimeTerminalCreate | null> {
    return isTuiAgentEnabled(agent, this.store?.getSettings()?.disabledTuiAgents)
      ? this.setupStartup.retry(worktreeId, agent, create)
      : Promise.resolve(null)
  }
}
