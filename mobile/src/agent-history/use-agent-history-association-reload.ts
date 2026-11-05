import { useEffect, useState } from 'react'
import type { AiVaultScope } from '../../../src/shared/ai-vault/contracts/ai-vault-types'
import { getCachedWorktrees, getProvenCachedWorktrees } from '../cache/worktree-cache'
import type { RpcClient } from '../transport/rpc-client'
import type { ConnectionState } from '../transport/types'
import { worktreeCatalogRead } from '../worktree/worktree-catalog-operations'
import type { Worktree } from '../worktree/workspace-list-types'

type AssociationFeed = {
  getAssociationRevision: () => number
  subscribe: (listener: () => void) => () => void
}

type LoadSessions = (options: { scope: AiVaultScope; force: boolean }) => void

const clientWorktreeCache = new WeakMap<RpcClient, Map<string, Worktree[]>>()

function readInitialHistoryWorktrees(
  hostId: string,
  client: RpcClient | null
): { worktrees: Worktree[]; loaded: boolean } {
  const fromClient = client ? clientWorktreeCache.get(client)?.get(hostId) : undefined
  if (fromClient !== undefined) {
    return { worktrees: fromClient, loaded: true }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: proven cache stores the same worktree rows this panel already reads as Worktree[].
  const proven = getProvenCachedWorktrees(hostId) as Worktree[] | null
  if (proven && proven.length > 0) {
    return { worktrees: proven, loaded: true }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: cold-start/Continue seed rows carry worktreeId and path for initial scope derivation.
  const seeded = getCachedWorktrees(hostId) as Worktree[] | null
  return { worktrees: seeded ?? [], loaded: false }
}

export type MobileHistoryWorktreeState = {
  worktrees: Worktree[]
  worktreesLoaded: boolean
  setWorktrees: (worktrees: Worktree[]) => void
  setWorktreesLoaded: (loaded: boolean) => void
}

/** Seeds worktrees synchronously from the client or proven host cache before history state effects register. */
export function useMobileHistoryWorktreeState(
  hostId: string,
  client: RpcClient | null
): MobileHistoryWorktreeState {
  const [worktrees, setWorktrees] = useState<Worktree[]>(
    () => readInitialHistoryWorktrees(hostId, client).worktrees
  )
  const [worktreesLoaded, setWorktreesLoaded] = useState(
    () => readInitialHistoryWorktrees(hostId, client).loaded
  )
  return { worktrees, worktreesLoaded, setWorktrees, setWorktreesLoaded }
}

/** Refreshes worktrees from worktree.ps after history state effects register so status.get dispatches first. */
export function useMobileHistoryWorktreeEffect(
  hostId: string,
  client: RpcClient | null,
  connState: ConnectionState,
  state: Pick<MobileHistoryWorktreeState, 'setWorktrees' | 'setWorktreesLoaded'>
): void {
  const { setWorktrees, setWorktreesLoaded } = state
  useEffect(() => {
    if (!client || connState !== 'connected') {
      return
    }
    let cancelled = false
    void (async () => {
      try {
        const worktreeReply = await worktreeCatalogRead.request(client, { limit: 10000 })
        if (cancelled) {
          return
        }
        const catalog = worktreeCatalogRead.interpret(worktreeReply)
        if (catalog.accepted) {
          // Why `?? []`: the member is salvaged, so an envelope the host answers without rows leaves it
          // absent, and `use-mobile-agent-history-state.ts` calls `.find` on it unguarded.
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the rows stay opaque in the reader because three screens project them differently; this panel reads only `path` off a row to seed `scopePaths`.
          const rows = (catalog.value.worktrees ?? []) as Worktree[]
          let byHost = clientWorktreeCache.get(client)
          if (!byHost) {
            byHost = new Map()
            clientWorktreeCache.set(client, byHost)
          }
          byHost.set(hostId, rows)
          setWorktrees(rows)
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
  }, [client, connState, hostId, setWorktrees, setWorktreesLoaded])
}

/** Reloads history when a structured session attaches, and holds that reload behind an in-flight scan. */
export function useAgentHistoryAssociationReload(
  feed: AssociationFeed | null,
  loadSessions: LoadSessions,
  scope: AiVaultScope,
  activeLoads: { current: number },
  pendingReload: { current: (() => void) | null }
): void {
  useEffect(() => {
    if (!feed) {
      return
    }
    let revision = feed.getAssociationRevision()
    const stop = feed.subscribe(() => {
      const next = feed.getAssociationRevision()
      if (next === revision) {
        return
      }
      revision = next
      const reload = () => void loadSessions({ scope, force: false })
      if (activeLoads.current > 0) {
        pendingReload.current = reload
        return
      }
      reload()
    })
    return () => {
      stop()
      pendingReload.current = null
    }
  }, [activeLoads, feed, loadSessions, pendingReload, scope])
}
