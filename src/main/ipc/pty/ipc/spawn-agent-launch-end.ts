import {
  readTerminalStartFailure,
  type TerminalStartFailure
} from '../../../../shared/terminal-start-failure'
import {
  AGENT_LAUNCH_PANE_REFUSED_CODE,
  type AgentLaunchPaneAddress,
  type AgentLaunchPaneVerdict
} from '../../../../shared/agent-launch-pane-verdict'
import { AgentLaunchTabClosedError } from '../../../../shared/agent-launch-tab-closed'
import type { RunningAgentLaunchPane } from '../../../agent-launch/agent-launch-pane-attachment'
import type { AgentLaunchRuntime } from '../../../../shared/agent-launch-runtime'
import type { OrcaRuntimeService } from '../../../runtime/orca-runtime'
import { agentLaunchFailureCode } from '../../../runtime/rpc/methods/agent-launch-failure-code'
import type { PtyIpcSpawnState } from './spawn-state'

export type PaneAgentLaunch = {
  runtime: OrcaRuntimeService
  address: AgentLaunchPaneAddress
  paneKey: string
  running: RunningAgentLaunchPane
  /** The plan chooses the PTY execution shell. */
  launchRuntime?: AgentLaunchRuntime
  /** After provider dispatch, a failure cannot prove that nothing ran. */
  dispatched: boolean
  refuseIfClosed: () => void
}

type PaneAgentLaunchEnd =
  | { started: true }
  | { exitedDuringStart: true; terminalStartFailure?: TerminalStartFailure }
  | { error: unknown }

function finish(launch: PaneAgentLaunch, verdict: AgentLaunchPaneVerdict): void {
  launch.running.finish(verdict)
  launch.runtime.reportAgentLaunchPaneVerdict(launch.address, verdict)
}

export function endPaneAgentLaunch(ctx: PtyIpcSpawnState, end: PaneAgentLaunchEnd): Error | null {
  const launch = ctx.paneAgentLaunch
  ctx.paneAgentLaunch = null
  if (!launch) {
    return null
  }
  if ('exitedDuringStart' in end) {
    finish(launch, {
      kind: 'not-started',
      code: 'agent_session_exited_during_start',
      ...diagnosticFields(end.terminalStartFailure)
    })
    return null
  }
  const closed = launch.running.closedByUser()
  if ('started' in end) {
    if (closed) {
      stopClosed(launch)
    } else {
      finish(launch, { kind: 'proceed' })
    }
    return null
  }
  if (closed || end.error instanceof AgentLaunchTabClosedError) {
    stopClosed(launch)
    return toError(end.error)
  }
  finish(
    launch,
    // The provider may have started it before its answer was lost.
    launch.dispatched
      ? { kind: 'unconfirmed', ...diagnosticFields(readTerminalStartFailure(end.error)) }
      : {
          kind: 'not-started',
          code: agentLaunchFailureCode(end.error),
          ...diagnosticFields(readTerminalStartFailure(end.error))
        }
  )
  return new Error(AGENT_LAUNCH_PANE_REFUSED_CODE)
}

/** A pane closed during launch must stop any agent that may already have spawned. */
function stopClosed(launch: PaneAgentLaunch): void {
  const handle = launch.runtime.getTerminalHandleForPaneKey(launch.paneKey)
  if (handle) {
    void launch.runtime.closeTerminal(handle).catch(() => {})
  }
  launch.running.finish({ kind: 'withdrawn' })
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

function diagnosticFields(failure: TerminalStartFailure | undefined): {
  initialOutputDiagnostic?: 'git-bash-console-capacity'
} {
  return failure?.cause.kind === 'exited' && failure.cause.initialOutputDiagnostic
    ? { initialOutputDiagnostic: failure.cause.initialOutputDiagnostic }
    : {}
}
