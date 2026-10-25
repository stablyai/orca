import { randomUUID } from 'node:crypto'
import { AgentLaunch } from '../../../../shared/rpc-contract/agent-launch-params'
import { toAgentLaunchPreferences } from '../../../../shared/agent-launch-preferences'
import { hasClosedTerminalTabRecord } from '../../../../shared/closed-terminal-tab-tombstones'
import { parsePaneKey } from '../../../../shared/stable-pane-id'
import { AgentLaunchTabClosedError } from '../../../../shared/agent-launch-tab-closed'
import { trackRunningAgentLaunchPane } from '../../../agent-launch/agent-launch-pane-attachment'
import { agentLaunchTokenFor } from '../../../agent-launch/agent-launch-token'
import { resolveUnlaunchedIntent } from '../../../runtime/rpc/methods/agent-launch-intent-resolution'
import type { OrcaRuntimeService } from '../../../runtime/orca-runtime'
import type { Store } from '../../../persistence'
import { resolveEarlyPaneKey } from './spawn-begin'
import type { PtyIpcSpawnState } from './spawn-state'
import type { PtySpawnIpcArgs } from './spawn-types'

function closedInSession(store: Store | undefined, paneKey: string): boolean {
  const pane = parsePaneKey(paneKey)
  const session = store?.getWorkspaceSession()
  return Boolean(
    pane &&
    session &&
    (session.terminalSurfaceTombstonesByPaneKey?.[paneKey] ||
      hasClosedTerminalTabRecord(session.closedTerminalTabTombstonesByTabId, pane.tabId))
  )
}

function withPlannedLaunch(
  args: PtySpawnIpcArgs,
  planned: Awaited<ReturnType<OrcaRuntimeService['planAgentPaneLaunch']>>
): PtySpawnIpcArgs {
  const {
    agentLaunch: _launch,
    command: _command,
    launchConfig: _config,
    launchAgent: _agent,
    startupCommandDelivery: _delivery,
    telemetry: _telemetry,
    ...pane
  } = args
  const launchToken = agentLaunchTokenFor(
    {
      launchConfig: planned.launchConfig,
      ...(typeof args.launchToken === 'string' ? { launchToken: args.launchToken } : {})
    },
    randomUUID
  )
  return {
    ...pane,
    command: planned.command,
    ...(planned.env || launchToken
      ? {
          env: {
            ...args.env,
            ...planned.env,
            ...(launchToken ? { ORCA_AGENT_LAUNCH_TOKEN: launchToken } : {})
          }
        }
      : {}),
    ...(launchToken ? { launchToken } : {}),
    ...(planned.launchConfig ? { launchConfig: planned.launchConfig } : {}),
    ...(planned.launchAgent ? { launchAgent: planned.launchAgent } : {}),
    ...(planned.startupCommandDelivery
      ? { startupCommandDelivery: planned.startupCommandDelivery }
      : {}),
    ...(planned.telemetry ? { telemetry: planned.telemetry } : {})
  }
}

export async function planPaneAgentLaunch(ctx: PtyIpcSpawnState): Promise<void> {
  const { args, deps } = ctx
  // Adopting a live pane owner also adopts its already-running agent.
  if (args.agentLaunch === undefined || ctx.earlyStablePaneOwner) {
    return
  }
  const runtime = deps.runtime
  const paneKey = resolveEarlyPaneKey(args)
  const pane = paneKey ? parsePaneKey(paneKey) : null
  const request = typeof args.agentLaunch === 'object' ? args.agentLaunch : null
  const launch =
    request && 'launch' in request && typeof request.launch === 'object'
      ? request.launch
      : undefined
  const params = AgentLaunch.safeParse({ ...launch, paneKey })
  if (
    !runtime ||
    !paneKey ||
    !pane ||
    !args.worktreeId ||
    !params.success ||
    params.data.reuseTerminal ||
    params.data.prompt
  ) {
    throw new Error('agent_launch_request_invalid')
  }
  const running = trackRunningAgentLaunchPane({ worktreeId: args.worktreeId, paneKey })
  ctx.paneAgentLaunch = {
    runtime,
    address: { worktreeId: args.worktreeId, tabId: pane.tabId, leafId: pane.leafId },
    paneKey,
    running,
    dispatched: false,
    refuseIfClosed: () => {
      if (running.closedByUser() || closedInSession(deps.store, paneKey)) {
        throw new AgentLaunchTabClosedError()
      }
    }
  }
  const intent = await resolveUnlaunchedIntent(params.data, runtime, null)
  if (intent.target.kind !== 'existing') {
    throw new Error('agent_launch_request_invalid')
  }
  const launchPreferences = toAgentLaunchPreferences(intent.sessionOptions)
  const planned = await runtime.planAgentPaneLaunch(intent.target.worktree, {
    startupAgent: intent.agent,
    ...(intent.agentArgs !== undefined ? { agentArgs: intent.agentArgs } : {}),
    ...(launchPreferences ? { launchPreferences } : {}),
    ...(intent.launchSource ? { launchSource: intent.launchSource } : {}),
    ...(intent.cwd ? { cwd: intent.cwd } : {})
  })
  ctx.paneAgentLaunch.launchRuntime = planned.launchRuntime
  ctx.args = withPlannedLaunch(args, planned)
}
