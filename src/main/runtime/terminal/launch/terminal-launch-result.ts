import { terminalLaunchFacts } from '../../../../shared/agent-session-resume'
import { admitStablePaneAdoption } from '../../runtime-terminal-pane-identity'
import type { RuntimePtyController } from '../../runtime-pty-controller-contract'
import type { TerminalCreateOptions } from '../../runtime-terminal-contracts'
import type { RuntimePtyWorktreeRecord } from '../../runtime-terminal-state-records'
import type { TuiAgent } from '../../../../shared/tui-agent'
import {
  copySleepingAgentLaunchConfig,
  resolveLaunchCommandPaneAgent,
  resolveLaunchedAgent
} from '../../runtime-agent-launch-resolution'

type TerminalSpawnResult = Awaited<ReturnType<NonNullable<RuntimePtyController['spawn']>>>

export function resolveTerminalLaunchResult(
  result: TerminalSpawnResult,
  requested: Pick<
    TerminalCreateOptions,
    'launchConfig' | 'launchAgent' | 'launchToken' | 'title' | 'viewMode' | 'requireFreshPane'
  >
) {
  const stablePaneAdopted = admitStablePaneAdoption(result, requested)
  const adoptedStablePane =
    stablePaneAdopted ||
    result.isReattach === true ||
    result.agentSessionEnsure?.disposition === 'adopted'
  const refused = Boolean(result.agentResumeRefused)
  const owner = result.stablePaneOwner
  const surface =
    result.agentSessionEnsure?.owner.surface ??
    (owner ? { terminalHandle: owner.handle, tabId: owner.tabId, leafId: owner.leafId } : undefined)
  return {
    adoptedStablePane,
    surface,
    launchAgent: refused
      ? undefined
      : (result.launchAgent ?? (adoptedStablePane ? undefined : requested.launchAgent)),
    launchConfig: refused
      ? undefined
      : (result.launchConfig ?? (adoptedStablePane ? undefined : requested.launchConfig)),
    launchToken: refused
      ? undefined
      : (result.launchToken ?? (adoptedStablePane ? undefined : requested.launchToken)),
    effectiveTitle: refused || adoptedStablePane ? null : requested.title,
    effectiveViewMode: refused || adoptedStablePane ? undefined : requested.viewMode
  }
}

/** Returns the agent a fresh launch's command starts; null for an adopted pane, whose process was already running. */
export function recordTerminalLaunchMetadata(
  pty: RuntimePtyWorktreeRecord,
  result: TerminalSpawnResult,
  launch: ReturnType<typeof resolveTerminalLaunchResult>,
  command: string | undefined
): TuiAgent | null {
  if (launch.adoptedStablePane) {
    // A lower owner can supply facts before this runtime has a launch record.
    if (!pty.launchConfig && result.launchConfig) {
      pty.launchConfig = copySleepingAgentLaunchConfig(result.launchConfig)
    }
    pty.launchToken ??= result.launchToken ?? null
    pty.launchAgent ??= result.launchAgent ?? null
    if (pty.launchToken && !pty.launchIncarnationId) {
      pty.launchIncarnationId = pty.incarnationId
    }
    return null
  }
  pty.launchConfig = launch.launchConfig ? copySleepingAgentLaunchConfig(launch.launchConfig) : null
  pty.launchToken = launch.launchToken ?? null
  pty.launchIncarnationId = launch.launchToken ? pty.incarnationId : null
  pty.launchAgent = launch.launchAgent ?? null
  if (result.agentResumeRefused) {
    pty.launchCommandAgent = null
    return null
  }
  pty.launchCommandAgent = resolveLaunchCommandPaneAgent(command)
  return resolveLaunchedAgent(command, pty.launchAgent)
}

export function terminalLaunchPublicFacts(
  result: TerminalSpawnResult,
  adoptedStablePane: boolean,
  pty: RuntimePtyWorktreeRecord | null
) {
  return {
    ...terminalLaunchFacts(result),
    launchConfig: pty?.launchConfig ?? undefined,
    launchAgent: pty?.launchAgent ?? undefined,
    launchToken: pty?.launchToken ?? undefined,
    ...(!adoptedStablePane && result.coldRestore ? { coldRestore: result.coldRestore } : {}),
    ...(result.pid ? { processId: result.pid } : {}),
    ...(result.agentSessionEnsure
      ? { agentSessionDisposition: result.agentSessionEnsure.disposition }
      : {}),
    ...(adoptedStablePane ? { isReattach: true as const } : {})
  }
}
