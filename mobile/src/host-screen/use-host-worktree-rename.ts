import { useCallback } from 'react'
import type { RpcClient } from '../transport/rpc-client'
import { interpretOrThrowRefusalMessage } from '../transport/rpc-refusal-message'
import type { Worktree } from '../worktree/workspace-list-types'
import { worktreeDisplayNameWrite } from './host-screen-operations'
import type { HostScreenState } from './use-host-screen-state'
import {
  automaticWorktreeDisplayName,
  renamedWorktreeRows,
  worktreeDisplayNameUpdate
} from './worktree-display-name-edit'

export type WorktreeRenameOutcome = { ok: true } | { ok: false; error: string }

const RENAME_FAILED = 'Could not rename the worktree.'

/**
 * Worktree Settings' save. Not optimistic like the pin toggle: the panel waits on the host, as the
 * desktop dialog does, so a refusal leaves the old name in place and the panel open on the message.
 */
export function useHostWorktreeRename(args: {
  clientForRow: (item: Worktree) => RpcClient | null
  fetchWorktrees: () => Promise<void>
  state: HostScreenState
}) {
  const { clientForRow, fetchWorktrees, state } = args
  const { setLastKnownWorktrees, setServerWorkspaces, setWorktrees } = state

  return useCallback(
    async (item: Worktree, draft: string): Promise<WorktreeRenameOutcome> => {
      const displayName = worktreeDisplayNameUpdate(item.displayName, draft)
      if (displayName === null) {
        return { ok: true }
      }
      const rowClient = clientForRow(item)
      if (!rowClient) {
        return { ok: false, error: RENAME_FAILED }
      }
      try {
        // Why the row's client: a server's workspace is renamed where it runs, like its pin.
        const reply = await worktreeDisplayNameWrite.request(rowClient, {
          worktree: `id:${item.worktreeId}`,
          displayName
        })
        interpretOrThrowRefusalMessage(
          () => worktreeDisplayNameWrite.interpret(reply),
          RENAME_FAILED
        )
      } catch (error) {
        return { ok: false, error: (error instanceof Error && error.message) || RENAME_FAILED }
      }
      const shown = displayName || automaticWorktreeDisplayName(item)
      const rename = (list: readonly Worktree[]) => renamedWorktreeRows(list, item, shown)
      setWorktrees(rename)
      setLastKnownWorktrees(rename)
      setServerWorkspaces((prev) => ({ ...prev, worktrees: rename(prev.worktrees) }))
      void fetchWorktrees()
      return { ok: true }
    },
    [clientForRow, fetchWorktrees]
  )
}
