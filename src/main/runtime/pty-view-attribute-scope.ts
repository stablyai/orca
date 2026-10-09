import { parseAppSshPtyId } from '../../shared/ssh-pty-id'
import type { RuntimePtyWorktreeRecord } from './runtime-terminal-state-records'
import { inferWorktreeIdFromPtyId } from './runtime-worktree-path-identity'
import type { TerminalViewAttributeScope } from './terminal-view-attribute-store'

/** View-attribute scope for one PTY. Why the id fallbacks: live daemon bytes
 *  can create the emulator before renderer graph sync records the worktree. */
export function resolvePtyViewAttributeScope(
  ptyId: string,
  record: Pick<RuntimePtyWorktreeRecord, 'worktreeId' | 'connectionId'> | undefined
): TerminalViewAttributeScope {
  return {
    worktreeId: record?.worktreeId ?? inferWorktreeIdFromPtyId(ptyId),
    connectionId: record?.connectionId ?? parseAppSshPtyId(ptyId)?.connectionId ?? null
  }
}
