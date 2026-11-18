import { useCallback } from 'react'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import { isSameWorktreeRow } from '../../worktree/row-presentation/worktree-host-row-identity'
import type { Worktree } from '../../worktree/workspace-list/workspace-list-types'
import type { HostScreenState } from '../use-host-screen-state'
import { worktreeReadStateWrite, worktreeStatusWrite } from './workspace-row-menu-operations'

type RowPatch = Partial<Pick<Worktree, 'unread' | 'workspaceStatus'>>

/** Read state and status, written at the row's owner as desktop does, drawn before the host answers. */
export function useHostWorktreeRowWrites(args: {
  clientForRow: (item: Worktree) => RpcClient | null
  state: Pick<HostScreenState, 'setServerWorkspaces' | 'setWorktrees' | 'setLastKnownWorktrees'>
}) {
  const { clientForRow, state } = args
  const { setServerWorkspaces, setWorktrees, setLastKnownWorktrees } = state

  const patchRow = useCallback(
    (item: Worktree, patch: RowPatch) => {
      const apply = (rows: readonly Worktree[]) =>
        rows.map((row) => (isSameWorktreeRow(row, item) ? { ...row, ...patch } : row))
      if (item.hostId?.startsWith('runtime:')) {
        setServerWorkspaces((prev) => ({ ...prev, worktrees: apply(prev.worktrees) }))
        return
      }
      setWorktrees(apply)
      setLastKnownWorktrees(apply)
    },
    [setServerWorkspaces, setWorktrees, setLastKnownWorktrees]
  )

  const write = useCallback(
    (
      item: Worktree,
      patch: RowPatch,
      previous: RowPatch,
      send: (client: RpcClient) => Promise<boolean>
    ) => {
      const rowClient = clientForRow(item)
      if (!rowClient) {
        return
      }
      patchRow(item, patch)
      void send(rowClient)
        .catch(() => false)
        .then((accepted) => {
          if (!accepted) {
            patchRow(item, previous)
          }
        })
    },
    [clientForRow, patchRow]
  )

  const setWorktreeUnread = useCallback(
    (item: Worktree, unread: boolean) =>
      write(item, { unread }, { unread: item.unread }, async (client) => {
        const reply = await worktreeReadStateWrite.request(client, {
          worktree: `id:${item.worktreeId}`,
          isUnread: unread,
          // As desktop's Mark Read: the agents' alerts are read too.
          ...(unread ? {} : { acknowledgeAttention: true })
        })
        return worktreeReadStateWrite.interpret(reply).accepted
      }),
    [write]
  )

  const setWorktreeStatus = useCallback(
    (item: Worktree, workspaceStatus: string) =>
      write(
        item,
        { workspaceStatus },
        { workspaceStatus: item.workspaceStatus },
        async (client) => {
          const reply = await worktreeStatusWrite.request(client, {
            worktree: `id:${item.worktreeId}`,
            workspaceStatus
          })
          return worktreeStatusWrite.interpret(reply).accepted
        }
      ),
    [write]
  )

  return { setWorktreeUnread, setWorktreeStatus }
}
