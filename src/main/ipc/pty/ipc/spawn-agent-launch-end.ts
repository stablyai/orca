// Finishes a pane's own agent launch on every way its spawn ends.

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
  /** The plan's runtime fact: the PTY's shell comes only from it, as for a host launch. */
  launchRuntime?: AgentLaunchRuntime
  /** The provider was asked for the process: a failure after this proves nothing ran. */
  dispatched: boolean
  /** Right before the provider spawn: refuses a launch whose pane the user closed meanwhile. */
  refuseIfClosed: () => void
}

type PaneAgentLaunchEnd =
  | { started: true }
  /** The agent's process started, then exited before it registered. */
  | { exitedDuringStart: true }
  | { error: unknown }

function finish(launch: PaneAgentLaunch, verdict: AgentLaunchPaneVerdict): void {
  launch.running.finish(verdict)
  launch.runtime.reportAgentLaunchPaneVerdict(launch.address, verdict)
}

/** Ends the pane's launch, once; returns the error its spawn throws, if it failed. */
export function endPaneAgentLaunch(ctx: PtyIpcSpawnState, end: PaneAgentLaunchEnd): Error | null {
  const launch = ctx.paneAgentLaunch
  ctx.paneAgentLaunch = null
  if (!launch) {
    return null
  }
  if ('exitedDuringStart' in end) {
    finish(launch, { kind: 'not-started', code: 'agent_session_exited_during_start' })
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
      ? { kind: 'unconfirmed' }
      : { kind: 'not-started', code: agentLaunchFailureCode(end.error) }
  )
  return new Error(AGENT_LAUNCH_PANE_REFUSED_CODE)
}

/** The user closed it while it started: its agent, if one spawned, stops, as a closed tab's does. */
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
