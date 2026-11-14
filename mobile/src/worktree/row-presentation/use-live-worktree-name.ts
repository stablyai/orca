import { useCallback, useRef, useState } from 'react'
import { useFocusEffect } from 'expo-router'
import { getRepoIdFromWorktreeId } from '../../../../src/shared/worktree/id'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import { subscribeSharedClientEvents } from '../../transport/connection/shared-client-events'
import type { ConnectionState } from '../../transport/connection/connection-state'
import { sessionWorktreeRecordRead } from '../catalog/session-worktree-record-operations'
import { getLiveWorktreeDisplayName } from './worktree-display-name'
import {
  getFloatingWorkspaceTitle,
  isFloatingWorkspaceWorktreeId
} from '../../session/floating-workspace'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import {
  classifyWorktreeShowResponse,
  type WorktreeShowResolution
} from '../navigation/worktree-show-resolution'

const WORKTREE_NAME_FALLBACK_POLL_MS = 3000

type Params = {
  client: RpcClient | null
  connState: ConnectionState
  routeName?: string
  worktreeId: string
}

export type LiveWorktreeName = {
  name: string
  /** Where the worktree lives on its host; null until the host's record arrives. */
  path: string | null
  hostId: string | null
  /** The checked-out branch without refs/heads/; null for folders, detached heads and until the record arrives. */
  branch: string | null
  resolution: WorktreeShowResolution
}

export function useLiveWorktreeName({
  client,
  connState,
  routeName,
  worktreeId
}: Params): LiveWorktreeName {
  useMobileTranslation()
  // Floating workspaces have no worktree record; probing would keep fallback polling forever.
  const isFloatingWorkspace = isFloatingWorkspaceWorktreeId(worktreeId)
  const routeNameHint = routeName?.trim() ?? ''
  const [worktreeName, setWorktreeName] = useState<{
    worktreeId: string
    name: string
    path?: string | null
    hostId?: string | null
    branch?: string | null
  }>(() => ({ worktreeId, name: routeNameHint }))
  // Key verdicts by route so a previous workspace’s deletion cannot escape into the new one.
  const [resolved, setResolved] = useState<{
    worktreeId: string
    resolution: WorktreeShowResolution
  }>(() => ({ worktreeId, resolution: 'unknown' }))
  // Repo-scan failures can misreport live workspaces as missing; require a confirming fallback read.
  const missingStreakRef = useRef({ worktreeId, count: 0 })

  // Reset during render on route change; an effect would commit and re-render the session screen.
  const [routeSource, setRouteSource] = useState({ worktreeId, routeNameHint })
  if (routeSource.worktreeId !== worktreeId || routeSource.routeNameHint !== routeNameHint) {
    setRouteSource({ worktreeId, routeNameHint })
    setWorktreeName((current) =>
      current.worktreeId === worktreeId && current.name === routeNameHint
        ? current
        : { worktreeId, name: routeNameHint }
    )
    setResolved((current) =>
      current.worktreeId === worktreeId ? current : { worktreeId, resolution: 'unknown' }
    )
  }

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
            const path = worktree?.path || null
            const hostId = worktree?.hostId ?? null
            // Match desktop formatBranchName by hiding the refs/heads/ prefix.
            const branch = worktree?.branch?.replace(/^refs\/heads\//, '') || null
            setWorktreeName((current) =>
              current.worktreeId === worktreeId &&
              current.name === liveName &&
              current.path === path &&
              current.hostId === hostId &&
              current.branch === branch
                ? current
                : { worktreeId, name: liveName, path, hostId, branch }
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
      const unsubscribe = subscribeSharedClientEvents(client, (event) => {
        if (stale) {
          return
        }
        if (event.type === 'ready') {
          eventStreamReady = true
          if (hasSuccessfulRefresh) {
            stopFallbackPoll()
          }
          if ('replayed' in event) {
            // A reopened stream or path switch missed title notices.
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
      })
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
    return {
      name: getFloatingWorkspaceTitle(),
      path: null,
      hostId: 'local',
      branch: null,
      resolution: 'unknown'
    }
  }
  return {
    name: worktreeName.worktreeId === worktreeId ? worktreeName.name : routeNameHint,
    path: worktreeName.worktreeId === worktreeId ? (worktreeName.path ?? null) : null,
    hostId: worktreeName.worktreeId === worktreeId ? (worktreeName.hostId ?? null) : null,
    branch: worktreeName.worktreeId === worktreeId ? (worktreeName.branch ?? null) : null,
    resolution: resolved.worktreeId === worktreeId ? resolved.resolution : 'unknown'
  }
}
