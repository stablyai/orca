import type { TerminalWorkspaceLaunchScope } from '../../runtime-legacy-worker-terminal-recovery-types'
import type { ClaudeAgentTeamsMode } from '../../../../shared/claude-agent-teams-tmux-compat'
import * as dependencies from '../../orca-runtime-create-terminal-dependencies'
import type { PaneSpawnOperation } from '../../../ipc/pty/pane/pane-spawn-operation'
import { withAgentLaunchToken } from '../../../agent-launch/agent-launch-token'
import type { terminalCreateTeamAllocation } from './terminal-create-team-allocation'

export async function prepareWorkspaceTerminalSpawn({
  workspace,
  launchOpts,
  initialSize,
  cwd,
  preAllocatedHandle,
  tabId,
  leafId,
  launchToken,
  teamAllocation,
  releaseStablePaneCreate,
  launcherSpawnArgs,
  reportPtySpawnCommitted,
  operation,
  ports
}: {
  workspace: TerminalWorkspaceLaunchScope
  launchOpts: dependencies.TerminalCreateOptions
  initialSize: { cols: number; rows: number }
  cwd: string
  preAllocatedHandle: string
  tabId: string
  leafId: string
  launchToken: string | undefined
  teamAllocation: ReturnType<typeof terminalCreateTeamAllocation>
  releaseStablePaneCreate: () => void
  launcherSpawnArgs: ReturnType<typeof dependencies.admitPairedCreateColors>
  reportPtySpawnCommitted: () => void
  operation?: PaneSpawnOperation
  ports: {
    claudeAgentTeamsMode: ClaudeAgentTeamsMode | undefined
    buildTerminalWorkspaceEnv: (
      workspace: TerminalWorkspaceLaunchScope,
      env: Record<string, string>,
      teamEnv?: Record<string, string>
    ) => Record<string, string>
    paneStartStatusArgs: dependencies.PaneStartArgsOf
  }
}) {
  const baseEnv = withAgentLaunchToken(launchOpts.env, launchToken)
  const agentTeams = await teamAllocation
    .prepare(
      {
        launchConfig: launchOpts.launchConfig,
        command: launchOpts.command,
        claudeAgentTeamsSourceCommand: launchOpts.claudeAgentTeamsSourceCommand,
        claudeAgentTeamsMode: ports.claudeAgentTeamsMode,
        baseEnv: { ...process.env, ...baseEnv },
        adoptedBeforeLaunch: launchOpts.attachOnly
      },
      preAllocatedHandle
    )
    .catch((error: unknown) => {
      releaseStablePaneCreate()
      throw error
    })
  const { plan: agentTeamsPlan, sequencedStartupCommand } = agentTeams
  const effectiveLaunchConfig = agentTeams.effectiveLaunchConfig
  const env = ports.buildTerminalWorkspaceEnv(
    workspace,
    {
      ...baseEnv,
      ...(sequencedStartupCommand
        ? {
            [dependencies.SETUP_AGENT_SEQUENCE_STARTUP_COMMAND_ENV]: sequencedStartupCommand
          }
        : {})
    },
    agentTeamsPlan?.env
  )
  const terminalColorQueryReplies = dependencies.getTerminalViewerColors()

  const spawnArgs = {
    ...initialSize,
    cwd,
    command: sequencedStartupCommand
      ? launchOpts.command
      : (agentTeamsPlan?.command ?? launchOpts.command),
    launchAgent: launchOpts.launchAgent,
    launchConfig: effectiveLaunchConfig,
    ...(launchToken ? { launchToken } : {}),
    commandDelivery: 'provider',
    ...(launchOpts.attachOnly ? { attachOnly: true } : {}),
    ...(launchOpts.expectedIncarnationId
      ? { expectedIncarnationId: launchOpts.expectedIncarnationId }
      : {}),
    startupCommandDelivery: launchOpts.startupCommandDelivery,
    env,
    envToDelete: dependencies.mergeTerminalEnvDeletionKeys(
      launchOpts.envToDelete,
      agentTeamsPlan?.envToDelete
    ),
    resumeProviderSession: launchOpts.resumeProviderSession,
    ...(launchOpts.resumeOrigin ? { resumeOrigin: launchOpts.resumeOrigin } : {}),
    telemetry: launchOpts.telemetry,
    connectionId: workspace.connectionId,
    worktreeId: workspace.id,
    preAllocatedHandle,
    tabId,
    leafId,
    ...dependencies.spawnShellInputs(launchOpts),
    ...(terminalColorQueryReplies ? { terminalColorQueryReplies } : {}),
    ...launcherSpawnArgs,
    terminalKittyKeyboardProtocol: launchOpts.terminalKittyKeyboardProtocol,
    ...(launchOpts.agentSessionClaim
      ? {
          agentSessionEnsure: {
            claim: launchOpts.agentSessionClaim,
            surface: {
              worktreeId: workspace.id,
              tabId,
              leafId,
              terminalHandle: preAllocatedHandle
            }
          }
        }
      : {}),
    ...(launchOpts.agentSessionCreateOperationId
      ? {
          agentSessionCreateOperationId: launchOpts.agentSessionCreateOperationId
        }
      : {}),
    ...dependencies.callerSpawnScope(launchOpts),
    ...(launchOpts.onPtySpawnCommitted ? { onPtySpawnCommitted: reportPtySpawnCommitted } : {}),
    paneSpawnOperation: operation,
    ...dependencies.newTabIn(launchOpts),
    ...(launchOpts.afterTabId ? { afterTabId: launchOpts.afterTabId } : {}),
    ...(launchOpts.sessionId ? { sessionId: launchOpts.sessionId } : {}),
    ...(launchOpts.isNewSession ? { isNewSession: true } : {}),
    ...dependencies.BACKGROUND_TERMINAL_SPAWN_FLAGS,
    ...ports.paneStartStatusArgs(launchOpts)
  } satisfies Parameters<typeof dependencies.spawnInAdmittedPane>[2]
  return { spawnArgs, effectiveLaunchConfig }
}
