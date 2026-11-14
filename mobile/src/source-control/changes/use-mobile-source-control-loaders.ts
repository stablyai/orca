import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react'
import { hashKey, useQueryClient } from '@tanstack/react-query'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import type { MobileSourceControlSettings } from '../settings/mobile-source-control-settings-operations'
import { useMobileSourceControlSettings } from '../settings/mobile-source-control-settings'
import { useFocusEffect } from 'expo-router'
import type { HostInstance } from 'react-native'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import type { ConnectionState } from '../../transport/connection/connection-state'
import { useWorkspaceExecutionHost } from '../../navigation/workspace-execution-host'
import { isSyntheticWorkspaceRoute } from '../../session/synthetic-workspace-route'
import { defineHostQuery, readHostQueryLive, useHostQuery } from '../../query/host-query'
import { hostScreenState } from '../../query/host-query-screen-state'
import { useLastShownData } from '../../query/use-last-shown-data'
import {
  readBranchCompareOutcome,
  type BranchCompareAttempt
} from '../branches/mobile-branch-compare-outcome'
import {
  gitStatusQuery,
  publishGitStatusSummary,
  type GitStatusRead
} from './mobile-git-status-query'
import { hostQueryKey } from '../../query/host-query-key'
import type {
  LoadStatusOptions,
  MobileBranchCompareState,
  ScreenState
} from './mobile-source-control-screen-state'

type Params = {
  hostId: string
  client: RpcClient | null
  connState: ConnectionState
  statusIdentityKey: string
  worktreeId: string
  setActionError: (message: string | null) => void
  onStatusLoadSuccess?: () => void
}

const NO_INPUT = {}

// The compare base can be the branch's upstream, so each status read Changes shows brings its own compare.
type ChangesCompareInput = { read: number; upstream: boolean; upstreamName: string | null }

// One compare per status read: going back and forth finds it, and a failed one is read again when Changes is back on top.
const changesBranchCompareQuery = defineHostQuery<ChangesCompareInput, BranchCompareAttempt>({
  family: 'git.changesBranchCompare',
  staleTime: (query) => (query.state.data?.kind === 'failed' ? 0 : Infinity),
  gcTime: 60_000,
  fetch: (client, target, input) =>
    readBranchCompareOutcome(client, target.worktree ?? '', {
      compareAgainstUpstream: input.upstream,
      upstreamName: input.upstreamName ?? undefined
    })
})

export type MobileSourceControlLoaders = {
  screenState: ScreenState
  branchCompareState: MobileBranchCompareState
  mountedRef: MutableRefObject<boolean>
  setRootRef: (node: HostInstance | null) => void
  loadStatus: (options?: LoadStatusOptions) => Promise<boolean>
  // Shown rows are being re-read; feeds the header's refresh line.
  refreshing: boolean
  settings: MobileSourceControlSettings
  // Desktop's rebase target; kept apart from the compare so a failed or unsupported compare keeps it.
  rebaseBaseRef: string | null
}

export function useMobileSourceControlLoaders(params: Params): MobileSourceControlLoaders {
  const {
    hostId,
    client,
    connState,
    statusIdentityKey,
    worktreeId,
    setActionError,
    onStatusLoadSuccess
  } = params
  // Desktop's settings decide the compare base here and the list order and diffs upstream.
  const { settings, reload: reloadSettings } = useMobileSourceControlSettings(
    hostId,
    client,
    connState
  )
  const compareAgainstUpstream = settings.compareAgainstUpstream
  const queryClient = useQueryClient()
  const exec = useWorkspaceExecutionHost() ?? 'local'
  const target = useMemo(() => ({ exec, worktree: worktreeId }), [exec, worktreeId])
  const statusEnabled = worktreeId !== '' && !isSyntheticWorkspaceRoute(worktreeId)
  const refocusRef = useRef(false)
  // A screen under another one stops observing, so it revalidates when it is back on top rather than while hidden.
  const [focused, setFocused] = useState(true)
  useFocusEffect(
    useCallback(() => {
      setFocused(true)
      // Coming back retires the last action's error; background reads never clear it, so a newer failure survives them.
      if (refocusRef.current) {
        setActionError(null)
      }
      refocusRef.current = true
      // Review reads and writes this same status entry, so coming back shows what it staged without another read.
      return () => setFocused(false)
    }, [setActionError])
  )
  const statusQuery = useHostQuery(gitStatusQuery, { hostId, client }, target, NO_INPUT, {
    enabled: statusEnabled,
    subscribed: focused
  })
  // Published as each read is accepted: a summary read answering just after would otherwise look newer.
  useEffect(() => {
    const statusKey = hostQueryKey(hostId, gitStatusQuery.family, target, NO_INPUT)
    const statusHash = hashKey(statusKey)
    const publish = (accepted: boolean) => {
      const state = queryClient.getQueryState<GitStatusRead>(statusKey)
      if (state?.data) {
        void publishGitStatusSummary(
          queryClient,
          hostId,
          target,
          state.data,
          state.dataUpdatedAt,
          accepted
        )
      }
    }
    publish(false)
    return queryClient.getQueryCache().subscribe((event) => {
      if (
        event.type === 'updated' &&
        event.action.type === 'success' &&
        event.query.queryHash === statusHash
      ) {
        publish(true)
      }
    })
  }, [hostId, queryClient, target])
  const mountedRef = useRef(true)
  const setRootRef = useCallback((node: HostInstance | null): void => {
    // Invalidate route-detached RPC writes without waiting for passive cleanup.
    mountedRef.current = node !== null
  }, [])

  // Each status read that lands, and a new compare setting, brings its compare; Review shares the status
  // entry, so its reads wait until Changes is back on top and then compare once.
  const { data: statusRead, error: statusError, isFetching: statusFetching } = statusQuery
  const compareInput = useMemo(
    (): ChangesCompareInput | null =>
      statusRead?.kind === 'ready'
        ? {
            read: statusQuery.dataUpdatedAt,
            upstream: compareAgainstUpstream,
            upstreamName: statusRead.status.upstreamStatus?.upstreamName ?? null
          }
        : null,
    [statusRead, statusQuery.dataUpdatedAt, compareAgainstUpstream]
  )
  // A read in flight brings its own compare, so a revisit compares once, after its status lands.
  const compareEnabled = compareInput !== null && !statusFetching && connState === 'connected'
  const compareQuery = useHostQuery(
    changesBranchCompareQuery,
    { hostId, client },
    target,
    compareInput ?? { read: 0, upstream: false, upstreamName: null },
    { enabled: compareEnabled, subscribed: focused }
  )
  const attempt = useLastShownData(compareQuery.data, statusIdentityKey)
  // Clearing ready state on a failed or unsupported compare would claim No Changes despite retained branch commits.
  const readyCompare = useLastShownData(
    compareQuery.data?.kind === 'ready' ? compareQuery.data.result : undefined,
    statusIdentityKey
  )
  const branchCompareState = useMemo((): MobileBranchCompareState => {
    if (readyCompare) {
      return { kind: 'ready', result: readyCompare }
    }
    if (compareEnabled && compareQuery.data === undefined) {
      return { kind: 'loading' }
    }
    return attempt?.kind === 'failed'
      ? { kind: 'error', message: attempt.message }
      : { kind: 'idle' }
  }, [attempt, compareEnabled, compareQuery.data, readyCompare])
  // Desktop's rebase target; kept apart from the compare so a failed or unsupported compare keeps it.
  const rebaseBaseRef = attempt?.effectiveBaseRef ?? null

  const loadStatus = useCallback(
    async (options?: LoadStatusOptions) => {
      if (options?.rereadSettings) {
        reloadSettings()
      }
      if (!client || !statusEnabled) {
        return false
      }
      try {
        // A forced read must see what an action just wrote, so it replaces a read already out.
        const read = await readHostQueryLive(
          queryClient,
          gitStatusQuery,
          { hostId, client },
          target,
          NO_INPUT,
          { replace: options?.force === true }
        )
        if (read.kind !== 'ready') {
          return false
        }
        if (options?.clearActionErrorOnSuccess !== false) {
          setActionError(null)
        }
        // Fresh status can invalidate the failed-commit snapshot used by recovery prompts.
        onStatusLoadSuccess?.()
        return true
      } catch {
        return false
      }
    },
    [
      client,
      hostId,
      onStatusLoadSuccess,
      queryClient,
      reloadSettings,
      setActionError,
      statusEnabled,
      target
    ]
  )

  const t = useMobileTranslation()
  const screenState = useMemo((): ScreenState => {
    if (statusRead?.kind === 'ready') {
      return { kind: 'ready', status: statusRead.status }
    }
    if (statusRead?.kind === 'unavailable') {
      return {
        kind: 'unavailable',
        message: t(
          'sourceControl.loaders.updateDesktop',
          'Update Orca desktop to use Source Control on mobile.'
        )
      }
    }
    if (!statusEnabled) {
      return { kind: 'loading' }
    }
    const empty = client
      ? hostScreenState(
          { data: statusRead, error: statusError, isFetching: statusFetching },
          connState
        )
      : 'empty-connecting'
    if (empty === 'empty-connecting' || empty === 'empty-offline') {
      return {
        kind: 'error',
        message:
          connState === 'connected'
            ? t('sourceControl.loaders.connectingToDesktop', 'Connecting to desktop...')
            : t('sourceControl.loaders.waitingForDesktop', 'Waiting for desktop...')
      }
    }
    if (empty === 'empty-error') {
      return {
        kind: 'error',
        message:
          statusError?.message ||
          t('sourceControl.loaders.loadFailed', 'Unable to load source control')
      }
    }
    return { kind: 'loading' }
  }, [statusRead, statusError, statusFetching, statusEnabled, client, connState, t])

  return {
    screenState,
    branchCompareState,
    mountedRef,
    setRootRef,
    loadStatus,
    refreshing: statusQuery.isRefetching,
    settings,
    rebaseBaseRef
  }
}
