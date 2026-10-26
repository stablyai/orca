import { useEffect, useState } from 'react'
import type { RpcClient } from '../transport/rpc-client'
import type { Worktree } from '../worktree/workspace-list-types'
import { worktreeCatalogRead } from '../worktree/worktree-catalog-operations'
import { WORKTREE_PS_FULL_LIMIT } from '../worktree/worktree-catalog-snapshot-client'

type WorktreeRow = Pick<Worktree, 'path' | 'repoId' | 'branch'>

const NO_ROWS: readonly WorktreeRow[] = []

export function useHostWorktreeRows(
  client: RpcClient | null,
  connected: boolean,
  hostId: string
): readonly WorktreeRow[] {
  const [rows, setRows] = useState<readonly WorktreeRow[]>(NO_ROWS)

  useEffect(() => {
    if (!client || !connected) {
      return
    }
    let live = true
    worktreeCatalogRead
      .requestSingleFlight(client, hostId, { limit: WORKTREE_PS_FULL_LIMIT })
      .then((reply) => {
        const catalog = worktreeCatalogRead.interpret(reply)
        if (live && catalog.accepted && catalog.value.worktrees) {
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: proven worktree.ps rows, which the host screen's snapshot client admits as `Worktree`; the drawer reads only these three.
          setRows(catalog.value.worktrees as WorktreeRow[])
        }
      })
      .catch(() => {})
    return () => {
      live = false
    }
  }, [client, connected, hostId])

  return rows
}
