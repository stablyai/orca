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
  operation
}: {
  launchOpts: TerminalCreateOptions
  workspace: { id: string }
  preAllocatedHandle: string
  tabId: string
  leafId: string
  terminalColorQueryReplies: TerminalOscColorQueryReplyColors | null
  launcherSpawnArgs: PairedLauncherSpawnArgs
  commit: () => void
  operation: PaneSpawnOperation
}) {
  return {
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
    ...(launchOpts.afterTabId ? { afterTabId: launchOpts.afterTabId } : {}),
    ...(launchOpts.sessionId ? { sessionId: launchOpts.sessionId } : {}),
    ...(launchOpts.isNewSession ? { isNewSession: true } : {}),
    ...BACKGROUND_TERMINAL_SPAWN_FLAGS
  }
}
