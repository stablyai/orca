import type { startRuntimeLocalWorktreeTerminals } from './runtime-local-worktree-terminal-startup'
import type { CreateWorktreeResult } from '../../../../shared/worktree/create-types'
import { getSetupRunnerCommandPlatformForPath } from '../../../../shared/agent-launch/startup/setup-runner-command'
import type {
  WorktreeProvisionTerminalOptions,
  WorktreeTerminalProvisioningArgs
} from './runtime-worktree-terminal-provisioning'

export function provisionArgs(
  args: Parameters<typeof startRuntimeLocalWorktreeTerminals>[0],
  primaryTerminalHandle: string | null,
  hasStartupTerminal: boolean,
  wrappedSetupCommand?: string,
  setupCompletionToken?: string
): WorktreeTerminalProvisioningArgs {
  return {
    worktreeSelector: `id:${args.worktree.id}`,
    worktreeId: args.worktree.id,
    worktreePath: args.worktree.path,
    ...(args.setup ? { setup: args.setup } : {}),
    ...(args.defaultTabs ? { defaultTabs: args.defaultTabs } : {}),
    primaryTerminalHandle,
    hasStartupTerminal,
    ...(args.request.setupOnly !== undefined ? { setupOnly: args.request.setupOnly } : {}),
    callerProvidesSurface: callerProvidesInitialSurface(args),
    startupNeedsTerminal: args.startup !== undefined,
    setupCommandPlatform: setupPlatform(args.setup, 'posix'),
    observeSetupCompletion: args.request.observeSetupCompletion,
    ...(setupCompletionToken ? { setupCompletionToken } : {}),
    ...(wrappedSetupCommand ? { wrappedSetupCommand } : {})
  }
}

export function callerProvidesInitialSurface(
  args: Parameters<typeof startRuntimeLocalWorktreeTerminals>[0]
): boolean {
  // Background agent creates already leave their initial surface to the caller.
  return (
    args.promisedAgentChat === true ||
    (args.createdWithAgent !== undefined &&
      args.request.activate !== true &&
      args.request.runHooks !== true)
  )
}

export function setupPlatform(
  setup: CreateWorktreeResult['setup'],
  fallback: 'windows' | 'posix'
): 'windows' | 'posix' {
  return getSetupRunnerCommandPlatformForPath(setup?.runnerScriptPath ?? '', fallback)
}

export function ownerSurfacing(
  shouldSurface: boolean
): Pick<WorktreeProvisionTerminalOptions, 'surfaceOwner'> {
  return shouldSurface ? {} : { surfaceOwner: false }
}
