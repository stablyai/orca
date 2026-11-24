import type { CreateWorktreeResult } from '../../../../shared/worktree/create-types'
import type { RuntimeLocalWorktreeTerminalStartupResult } from './runtime-local-worktree-terminal-startup'

export function runtimeStartupTerminalReceipt(
  result: RuntimeLocalWorktreeTerminalStartupResult
): Pick<CreateWorktreeResult, 'startupTerminal'> {
  const {
    didSpawnStartup,
    startupTerminalHandle,
    startupTerminalTabId,
    startupTerminalPaneKey,
    startupTerminalPtyId
  } = result
  return didSpawnStartup && startupTerminalHandle
    ? {
        startupTerminal: {
          spawned: true,
          handle: startupTerminalHandle,
          ...(startupTerminalTabId ? { tabId: startupTerminalTabId } : {}),
          ...(startupTerminalPaneKey ? { paneKey: startupTerminalPaneKey } : {}),
          ...(startupTerminalPtyId ? { ptyId: startupTerminalPtyId } : {}),
          surface: 'background'
        }
      }
    : {}
}
