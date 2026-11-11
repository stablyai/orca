import type { prepareTerminalCreateTeamLaunch } from './terminal-create-team-allocation'
import type { TerminalWorkspaceLaunchScope } from '../../orchestration/terminal-authority/structured-sessions/runtime-legacy-worker-terminal-recovery-types'
import type { TerminalCreateOptions } from './terminal-create-options'
import type { SpawnIntent } from '../../../../shared/terminal/pty/admission/spawn-admission-contract'
import type { PaneSpawnOperation } from '../../../ipc/pty/pane/pane-spawn-operation'
import type { TerminalOscColorQueryReplyColors } from '../../../../shared/terminal/protocol/queries/terminal-osc-color-reply'
import type { PairedLauncherSpawnArgs } from '../view/terminal-view-attribute-store'
import { newTabIn } from '../layout/runtime-terminal-spawn-placement'

// No renderer exists yet; main must answer startup queries or agents such as Muse silently exit.
const BACKGROUND_TERMINAL_SPAWN_FLAGS = {
  initiallyHidden: true,
  persistHostSessionBinding: true
} as const

const spawnShellInputs = ({
  shellOverride,
  launchRuntime
}: Pick<TerminalCreateOptions, 'shellOverride' | 'launchRuntime'>) => ({
  ...(shellOverride ? { shellOverride } : {}),
  ...(launchRuntime ? { launchRuntime } : {})
})

/** Abort disconnected callers, refuse sleeping workspaces, and pass fork intent and the user's act for host validation. */
function callerSpawnScope(
  opts: Pick<TerminalCreateOptions, 'signal' | 'refuseSleptWorktree' | 'spawnIntent' | 'wslUserAct'>
): {
  signal?: AbortSignal
  refuseSleptWorktree?: true
  spawnIntent?: SpawnIntent
  wslUserAct?: true
} {
  return {
    ...(opts.signal ? { signal: opts.signal } : {}),
    ...(opts.refuseSleptWorktree ? { refuseSleptWorktree: true } : {}),
    ...(opts.spawnIntent ? { spawnIntent: opts.spawnIntent } : {}),
    ...(opts.wslUserAct ? { wslUserAct: true } : {})
  }
}

export function terminalSpawnOptions({
  launchOpts,
  workspace,
  preAllocatedHandle,
  tabId,
  leafId,
  terminalColorQueryReplies,
  launcherSpawnArgs,
  commit,
  operation,
  cwd,
  teamLaunch,
  launchToken
}: {
  launchOpts: TerminalCreateOptions
  workspace: TerminalWorkspaceLaunchScope
  preAllocatedHandle: string
  tabId: string
  leafId: string
  terminalColorQueryReplies: TerminalOscColorQueryReplyColors | null
  launcherSpawnArgs: PairedLauncherSpawnArgs
  commit: () => void
  operation: PaneSpawnOperation
  cwd: string
  teamLaunch: Awaited<ReturnType<typeof prepareTerminalCreateTeamLaunch>>
  launchToken: string | undefined
}) {
  return {
    ...(launchOpts.preparedReplacement
      ? { preparedReplacement: launchOpts.preparedReplacement }
      : {}),
    cwd,
    command: teamLaunch.command,
    launchAgent: launchOpts.launchAgent,
    ...(launchOpts.trustWorktreeId ? { trustWorktreeId: launchOpts.trustWorktreeId } : {}),
    launchConfig: teamLaunch.launchConfig,
    ...(launchToken ? { launchToken } : {}),
    commandDelivery: 'provider' as const,
    startupCommandDelivery: launchOpts.startupCommandDelivery,
    env: teamLaunch.env,
    envToDelete: teamLaunch.envToDelete,
    resumeProviderSession: launchOpts.resumeProviderSession,
    ...(launchOpts.resumeOrigin ? { resumeOrigin: launchOpts.resumeOrigin } : {}),
    telemetry: launchOpts.telemetry,
    connectionId: workspace.connectionId,
    worktreeId: workspace.id,
    resolvedWorkspace: workspace,
    preAllocatedHandle,
    tabId,
    leafId,

    ...spawnShellInputs(launchOpts),
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
    ...callerSpawnScope(launchOpts),
    ...(launchOpts.onPtySpawnCommitted ? { onPtySpawnCommitted: commit } : {}),
    paneSpawnOperation: operation,
    ...newTabIn(launchOpts),
    ...(launchOpts.split ? { groupSplit: launchOpts.split } : {}),
    ...(launchOpts.afterTabId ? { afterTabId: launchOpts.afterTabId } : {}),
    ...(launchOpts.sessionId ? { sessionId: launchOpts.sessionId } : {}),
    ...(launchOpts.isNewSession ? { isNewSession: true } : {}),
    ...BACKGROUND_TERMINAL_SPAWN_FLAGS
  }
}
