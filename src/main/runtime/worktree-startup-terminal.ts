import type { RuntimeTerminalCreate } from '../../shared/runtime-types'
import type { CreateWorktreeResult } from '../../shared/worktree/create-types'

export function projectWorktreeStartupTerminal(
  terminal: Pick<RuntimeTerminalCreate, 'handle' | 'tabId' | 'paneKey' | 'ptyId' | 'launchSnapshot'>
): NonNullable<CreateWorktreeResult['startupTerminal']> {
  return {
    spawned: true,
    handle: terminal.handle,
    ...(terminal.tabId ? { tabId: terminal.tabId } : {}),
    ...(terminal.paneKey ? { paneKey: terminal.paneKey } : {}),
    ...(terminal.ptyId ? { ptyId: terminal.ptyId } : {}),
    ...(terminal.launchSnapshot ? { launchSnapshot: terminal.launchSnapshot } : {}),
    surface: 'background'
  }
}
