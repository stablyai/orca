import { useCallback, useRef } from 'react'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import {
  getWorktreeRowIdentity,
  isSameWorktreeRow
} from '../../worktree/row-presentation/worktree-host-row-identity'
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
  // Writes to one row field run in order; only the latest one's refusal puts the row back, to the
  // value the host last took.
  const writesRef = useRef(
    new Map<string, { id: number; done: Promise<unknown>; committed: RowPatch }>()
  )

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
      const key = `${getWorktreeRowIdentity(item)}:${Object.keys(patch).join()}`
      const before = writesRef.current.get(key)
      const id = (before?.id ?? 0) + 1
      patchRow(item, patch)
      const done = (before?.done ?? Promise.resolve())
        .then(() => send(rowClient))
        .catch(() => false)
        .then((accepted) => {
          const entry = writesRef.current.get(key)
          if (!entry) {
            return
          }
          if (accepted) {
            entry.committed = patch
          } else if (entry.id === id) {
            patchRow(item, entry.committed)
          }
          // Settled with nothing queued behind it: the next write starts from the row as then listed.
          if (entry.id === id) {
            writesRef.current.delete(key)
          }
        })
      writesRef.current.set(key, { id, done, committed: before?.committed ?? previous })
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
