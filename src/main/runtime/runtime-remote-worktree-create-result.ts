import type { CreateWorktreeResult } from '../../shared/worktree/create-types'
import type { RuntimeRemoteWorktreeCreateArgs } from './runtime-remote-worktree-create-request'

export function finishRuntimeRemoteWorktreeCreate(args: {
  result: CreateWorktreeResult
  request: RuntimeRemoteWorktreeCreateArgs
  warning?: string
  didSpawnSetup: boolean
  didSpawnStartup: boolean
  wrappedSetupCommand?: string
  setupTerminalHandle: string | null
  startupTerminalHandle: string | null
  startupTerminalTabId: string | null
  startupTerminalPaneKey: string | null
  startupTerminalPtyId: string | null
}): CreateWorktreeResult {
  const returnedSetup = args.didSpawnSetup
    ? undefined
    : args.result.setup
      ? {
          ...args.result.setup,
          ...(args.didSpawnStartup && args.wrappedSetupCommand
            ? { command: args.wrappedSetupCommand }
            : {})
        }
      : undefined
  const resultForRenderer = returnedSetup
    ? { ...args.result, setup: returnedSetup }
    : (() => {
        const { setup: _setup, ...resultWithoutSetup } = args.result
        return resultWithoutSetup
      })()
  const resultWithStartupTerminal =
    args.didSpawnStartup && args.startupTerminalHandle
      ? {
          ...resultForRenderer,
          startupTerminal: {
            spawned: true,
            handle: args.startupTerminalHandle,
            ...(args.startupTerminalTabId ? { tabId: args.startupTerminalTabId } : {}),
            ...(args.startupTerminalPaneKey ? { paneKey: args.startupTerminalPaneKey } : {}),
            ...(args.startupTerminalPtyId ? { ptyId: args.startupTerminalPtyId } : {}),
            surface: 'background' as const
          }
        }
      : resultForRenderer
  const requested = args.request.runHooks ? 'run' : (args.request.setupDecision ?? 'inherit')
  const setupReceipt = {
    requested,
    hookFound: Boolean(args.result.setup),
    startupPolicy: args.result.setup?.waitForAgentStartup
      ? ('wait-for-setup' as const)
      : ('start-immediately' as const),
    state:
      requested === 'skip'
        ? ('skipped' as const)
        : !args.result.setup
          ? ('not_configured' as const)
          : args.didSpawnSetup
            ? ('running' as const)
            : ('spawn_failed' as const),
    ...(args.setupTerminalHandle ? { terminalHandle: args.setupTerminalHandle } : {})
  }
  const resultWithReceipt = args.request.awaitTerminalProvisioning
    ? { ...resultWithStartupTerminal, setupReceipt }
    : resultWithStartupTerminal
  return args.warning ? { ...resultWithReceipt, warning: args.warning } : resultWithReceipt
}
