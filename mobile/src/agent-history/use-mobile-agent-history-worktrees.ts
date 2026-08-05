import { useEffect, useState } from 'react'
import type { RpcClient } from '../transport/rpc-client'
import { RESUME_RPC_TIMEOUT_MS } from '../session/ai-vault-resume-preparation'
import type { RpcSuccess } from '../transport/types'
import type { Worktree } from '../worktree/workspace-list-types'

export function useMobileAgentHistoryWorktrees(
  client: Pick<RpcClient, 'sendRequest'> | null,
  connected: boolean
): { worktrees: Worktree[]; worktreesLoaded: boolean } {
  const [snapshot, setSnapshot] = useState<{
    client: Pick<RpcClient, 'sendRequest'> | null
    worktrees: Worktree[]
    loaded: boolean
  }>({ client: null, worktrees: [], loaded: false })
  useEffect(() => {
    if (!client || !connected) {
      return
    }
    let cancelled = false
    void (async () => {
      try {
        const response = await client.sendRequest(
          'worktree.ps',
          { limit: 10000 },
          { timeoutMs: RESUME_RPC_TIMEOUT_MS }
        )
        if (!cancelled && response.ok) {
          setSnapshot({
            client,
            worktrees: ((response as RpcSuccess).result as { worktrees: Worktree[] }).worktrees,
            loaded: true
          })
        }
      } catch {
        // Scope context is best effort; the session scan can still proceed unscoped.
      } finally {
        if (!cancelled) {
          setSnapshot((current) =>
            current.client === client
              ? { ...current, loaded: true }
              : { client, worktrees: [], loaded: true }
          )
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [client, connected])
  return snapshot.client === client && connected
    ? { worktrees: snapshot.worktrees, worktreesLoaded: snapshot.loaded }
    : { worktrees: [], worktreesLoaded: false }
}
