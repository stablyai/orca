import { useCallback, useEffect, useRef, useState } from 'react'
import { useFocusEffect } from 'expo-router'
import type { RuntimeClientEventStreamMessage } from '../../../src/shared/runtime-client-events'
import { getRepoIdFromWorktreeId } from '../../../src/shared/worktree/id'
import type { RpcClient } from '../transport/rpc-client'
import type { ConnectionState, RpcSuccess } from '../transport/types'
import { getLiveWorktreeDisplayName, type WorktreeDisplayNameSource } from './worktree-display-name'
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
  /** What the host last proved about this worktree still existing — see the bounce in
   *  use-missing-worktree-bounce.ts. */
  resolution: WorktreeShowResolution
}

export function useLiveWorktreeName({
  client,
  connState,
  routeName,
  worktreeId
}: Params): LiveWorktreeName {
  // Why: the floating sentinel has no worktree record, so worktree.show would
  // fail forever and keep the 3s fallback poll alive; its title is fixed.
  const isFloatingWorkspace = isFloatingWorkspaceWorktreeId(worktreeId)
  const routeNameHint = routeName?.trim() ?? ''
  const [worktreeName, setWorktreeName] = useState(() => ({
    worktreeId,
    name: routeNameHint
  }))
  // Why: keyed by id so a verdict about the previous route can never survive into the next one.
  const [resolved, setResolved] = useState<{
    worktreeId: string
    resolution: WorktreeShowResolution
  }>(() => ({ worktreeId, resolution: 'unknown' }))
  // Why: a transient desktop repo-scan rejection collapses the catalog to zero rows and
  // answers selector_not_found for a live worktree — one miss is suspicion, not proof.
  // The fallback poll guarantees a confirming read (a failed show never stops it).
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
        // Why: an event-driven refresh can overtake a slow fallback request;
        // only the newest read may publish or stop the retry poll.
        const generation = ++refreshGeneration
        try {
          const response = await client.sendRequest('worktree.show', {
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
          if (!response.ok) {
            return
          }
          const result = (response as RpcSuccess).result as {
            worktree?: WorktreeDisplayNameSource
          }
          const liveName = result.worktree
            ? getLiveWorktreeDisplayName([result.worktree], worktreeId)
            : null
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
              // Why: client events are not queued while disconnected, so replay
              // readiness must re-read the title once to close that event gap.
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
      // Why: route params are only an entry hint. The desktop/runtime owns
      // displayName. Modern runtimes push invalidations; the poll remains only
      // until that stream proves available, preserving older-runtime behavior.
      void refreshWorktreeName()
      return () => {
        stale = true
        stopFallbackPoll()
        unsubscribe()
      }
    }, [client, connState, worktreeId, isFloatingWorkspace])
  )

  if (isFloatingWorkspace) {
    // The sentinel has no worktree record to resolve, so nothing is ever proven about it.
    return { name: FLOATING_WORKSPACE_TITLE, resolution: 'unknown' }
  }
  return {
    name: worktreeName.worktreeId === worktreeId ? worktreeName.name : routeNameHint,
    resolution: resolved.worktreeId === worktreeId ? resolved.resolution : 'unknown'
  }
}
