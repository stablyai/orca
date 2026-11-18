import { useEffect, useState } from 'react'
import type { ConnectionState } from '../transport/connection/connection-state'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import { worktreeCatalogRead } from '../worktree/catalog/worktree-catalog-operations'
import type { Worktree } from '../worktree/workspace-list/workspace-list-types'
import type { MobileAiVaultProjectSetup } from './agent-history-scope-paths'
import { agentHistoryProjectSetupsRead } from './mobile-agent-history-operations'

const EMPTY_PROJECT_SETUPS: readonly MobileAiVaultProjectSetup[] = []

/** The host's workspaces and project setups History scopes its rows by. */
export function useAgentHistoryWorkspaceContext(
  client: RpcClient | null,
  connState: ConnectionState
) {
  const [worktrees, setWorktrees] = useState<Worktree[]>([])
  const [worktreesLoaded, setWorktreesLoaded] = useState(false)
  const [projectSetups, setProjectSetups] =
    useState<readonly MobileAiVaultProjectSetup[]>(EMPTY_PROJECT_SETUPS)

  // Worktree list seeds host-local scopePaths and current-worktree badge; project setups widen Project scope.
  useEffect(() => {
    if (!client || connState !== 'connected') {
      return
    }
    let cancelled = false
    void (async () => {
      try {
        const [worktreeReply, setupsReply] = await Promise.all([
          worktreeCatalogRead.request(client, { limit: 10000 }),
          agentHistoryProjectSetupsRead.request(client).catch(() => null)
        ])
        if (cancelled) {
          return
        }
        const setups = setupsReply && agentHistoryProjectSetupsRead.interpret(setupsReply)
        if (setups?.accepted) {
          setProjectSetups(setups.value.setups)
        }
        const catalog = worktreeCatalogRead.interpret(worktreeReply)
        if (catalog.accepted) {
          // Why `?? []`: the member is salvaged, so an envelope the host answers without rows leaves it
          // absent, and `use-mobile-agent-history-state.ts:61` calls `.find` on it unguarded.
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the rows stay opaque in the reader because three screens project them differently; this panel reads only `path` off a row to seed `scopePaths`, and `matrix-aivault.history-screen-worktree.ps-1` records every partition of its own family rendering a list rather than a crash.
          setWorktrees((catalog.value.worktrees ?? []) as Worktree[])
        }
      } catch {
        // Best-effort context: failed worktree list leaves scoped tabs scanning full history.
      } finally {
        // Mark loaded on failure too so scoped tabs fetch unscoped instead of spinning forever.
        if (!cancelled) {
          setWorktreesLoaded(true)
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [client, connState])

  return { worktrees, worktreesLoaded, projectSetups }
}
