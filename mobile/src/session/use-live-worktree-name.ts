import { useCallback, useEffect, useState } from 'react'
import { useFocusEffect } from 'expo-router'
import type { RpcClient } from '../transport/rpc-client'
import type { ConnectionState, RpcSuccess } from '../transport/types'
import { getLiveWorktreeDisplayName, type WorktreeDisplayNameSource } from './worktree-display-name'

type Params = {
  client: RpcClient | null
  connState: ConnectionState
  routeName?: string
  worktreeId: string
}

export function useLiveWorktreeName({ client, connState, routeName, worktreeId }: Params): string {
  const [worktreeName, setWorktreeName] = useState(() => routeName?.trim() ?? '')

  useEffect(() => {
    setWorktreeName(routeName?.trim() ?? '')
  }, [routeName, worktreeId])

  useFocusEffect(
    useCallback(() => {
      if (!client || connState !== 'connected') {
        return
      }
      let stale = false
      const refreshWorktreeName = async () => {
        try {
          const response = await client.sendRequest('worktree.show', {
            worktree: `id:${worktreeId}`
          })
          if (stale || !response.ok) {
            return
          }
          const result = (response as RpcSuccess).result as {
            worktree?: WorktreeDisplayNameSource
          }
          const liveName = result.worktree
            ? getLiveWorktreeDisplayName([result.worktree], worktreeId)
            : null
          if (liveName) {
            setWorktreeName((current) => (current === liveName ? current : liveName))
          }
        } catch {
          // Non-fatal: the route param remains a usable label until the next refresh.
        }
      }
      // Why: route params are only an entry hint. The desktop/runtime owns
      // displayName, including task-generated names that may settle after open.
      void refreshWorktreeName()
      const interval = setInterval(() => void refreshWorktreeName(), 3000)
      return () => {
        stale = true
        clearInterval(interval)
      }
    }, [client, connState, worktreeId])
  )

  return worktreeName
}
