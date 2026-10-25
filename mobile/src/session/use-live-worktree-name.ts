import { useCallback, useEffect, useRef, useState } from 'react'
import { useFocusEffect } from 'expo-router'
import type { RuntimeClientEventStreamMessage } from '../../../src/shared/runtime-client-events'
import { getRepoIdFromWorktreeId } from '../../../src/shared/worktree/id'
import type { RpcClient } from '../transport/rpc-client'
import type { ConnectionState } from '../transport/types'
import { sessionWorktreeRecordRead } from './mobile-session-read-operations'
import { getLiveWorktreeDisplayName } from './worktree-display-name'
import { FLOATING_WORKSPACE_TITLE, isFloatingWorkspaceWorktreeId } from './floating-workspace'
import {
  classifyWorktreeShowResponse,
  type WorktreeShowResolution
} from '../worktree/worktree-show-resolution'

const WORKTREE_NAME_FALLBACK_POLL_MS = 3000

type Params = {
  client: RpcClient | null
  connState: ConnectionState
  routeName?: string
  worktreeId: string
}

export type LiveWorktreeName = {
  name: string
  resolution: WorktreeShowResolution
}

export function useLiveWorktreeName({
  client,
  connState,
  routeName,
  worktreeId
}: Params): LiveWorktreeName {
  // Floating workspaces have no worktree record; probing would keep fallback polling forever.
  const isFloatingWorkspace = isFloatingWorkspaceWorktreeId(worktreeId)
  const routeNameHint = routeName?.trim() ?? ''
  const [worktreeName, setWorktreeName] = useState(() => ({
    worktreeId,
    name: routeNameHint
  }))
  // Key verdicts by route so a previous workspace’s deletion cannot escape into the new one.
  const [resolved, setResolved] = useState<{
    worktreeId: string
    resolution: WorktreeShowResolution
  }>(() => ({ worktreeId, resolution: 'unknown' }))
  // Repo-scan failures can misreport live workspaces as missing; require a confirming fallback read.
  const missingStreakRef = useRef({ worktreeId, count: 0 })

  useEffect(() => {
    setWorktreeName((current) =>
      current.worktreeId === worktreeId && current.name === routeNameHint
        ? current
        : { worktreeId, name: routeNameHint }
    )
  }, [routeNameHint, worktreeId])

  useEffect(() => {
    setResolved((current) =>
      current.worktreeId === worktreeId ? current : { worktreeId, resolution: 'unknown' }
    )
  }, [worktreeId])

  useFocusEffect(
    useCallback(() => {
      if (isFloatingWorkspace || !client || connState !== 'connected') {
        return
      }
      let stale = false
      let eventStreamReady = false
      let hasSuccessfulRefresh = false
      let fallbackInterval: ReturnType<typeof setInterval> | null = null
      let refreshGeneration = 0
      const repoId = getRepoIdFromWorktreeId(worktreeId)

      const stopFallbackPoll = (): void => {
        if (fallbackInterval !== null) {
          clearInterval(fallbackInterval)
          fallbackInterval = null
        }
      }
      const refreshWorktreeName = async (): Promise<void> => {
        // Only the newest request may publish or stop polling; events can overtake slow fallback reads.
        const generation = ++refreshGeneration
        try {
          const response = await sessionWorktreeRecordRead.request(client, {
            worktree: `id:${worktreeId}`
          })
          if (stale || generation !== refreshGeneration) {
            return
          }
          const classified = classifyWorktreeShowResponse(response)
          const streak = missingStreakRef.current
          missingStreakRef.current = {
            worktreeId,
            count:
              classified === 'missing'
                ? (streak.worktreeId === worktreeId ? streak.count : 0) + 1
                : 0
          }
          const resolution =
            classified === 'missing' && missingStreakRef.current.count < 2 ? 'unknown' : classified
          setResolved((current) =>
            current.worktreeId === worktreeId && current.resolution === resolution
              ? current
              : { worktreeId, resolution }
          )
          // Read selector_not_found before skip interpretation; only its confirmed code proves deletion.
          const accepted = sessionWorktreeRecordRead.interpret(response)
          if (!accepted.accepted) {
            return
          }
          const worktree = accepted.value
          const liveName = worktree ? getLiveWorktreeDisplayName([worktree], worktreeId) : null
          if (liveName) {
            setWorktreeName((current) =>
              current.worktreeId === worktreeId && current.name === liveName
                ? current
                : { worktreeId, name: liveName }
            )
          }
          hasSuccessfulRefresh = true
          if (eventStreamReady) {
            stopFallbackPoll()
          }
        } catch {
          // Non-fatal: the route param remains a usable label until the next refresh.
        }
      }

      const startFallbackPoll = (): void => {
        if (stale || fallbackInterval !== null) {
          return
        }
        fallbackInterval = setInterval(
          () => void refreshWorktreeName(),
          WORKTREE_NAME_FALLBACK_POLL_MS
        )
      }
      const invalidateAndRefresh = (): void => {
        hasSuccessfulRefresh = false
        startFallbackPoll()
        void refreshWorktreeName()
      }

      startFallbackPoll()
      const unsubscribe = client.subscribe(
        'runtime.clientEvents.subscribe',
        null,
        (payload: unknown) => {
          if (stale || !payload || typeof payload !== 'object') {
            return
          }
          const event = payload as RuntimeClientEventStreamMessage | { type: 'error' }
          if (event.type === 'ready') {
            const replayedAfterReconnect = eventStreamReady
            eventStreamReady = true
            if (hasSuccessfulRefresh) {
              stopFallbackPoll()
            }
            if (replayedAfterReconnect) {
              // Reconnect must reread once because disconnected clients miss title invalidations.
              invalidateAndRefresh()
            }
            return
          }
          if (event.type === 'end' || event.type === 'error') {
            eventStreamReady = false
            startFallbackPoll()
            return
          }
          if (
            event.type === 'reposChanged' ||
            (event.type === 'worktreesChanged' && event.repoId === repoId)
          ) {
            invalidateAndRefresh()
          }
        }
      )
      // Runtime displayName owns the title; retain fallback polling until invalidations prove available on this host.
      void refreshWorktreeName()
      return () => {
        stale = true
        stopFallbackPoll()
        unsubscribe()
      }
    }, [client, connState, worktreeId, isFloatingWorkspace])
  )

  if (isFloatingWorkspace) {
    return { name: FLOATING_WORKSPACE_TITLE, resolution: 'unknown' }
  }
  return {
    name: worktreeName.worktreeId === worktreeId ? worktreeName.name : routeNameHint,
    resolution: resolved.worktreeId === worktreeId ? resolved.resolution : 'unknown'
  }
}
