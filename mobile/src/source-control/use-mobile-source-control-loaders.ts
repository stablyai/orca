import {
  useCallback,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
  type MutableRefObject
} from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import type { MobileSourceControlSettings } from '../transport/settings-read-operations'
import { useMobileSourceControlSettings } from './mobile-source-control-settings'
import { useFocusEffect } from 'expo-router'
import { View } from 'react-native'
import type { RpcClient } from '../transport/rpc-client'
import {
  GenerationScopedRequestOwner,
  type RequestScope
} from '../transport/generation-scoped-request-owner'
import type { ConnectionState } from '../transport/types'
import { useWorkspaceExecutionHost } from '../navigation/workspace-execution-host'
import { isSyntheticWorkspaceRoute } from '../session/synthetic-workspace-route'
import { readHostQueryLive, useHostQuery } from '../query/host-query'
import { hostQueryKey } from '../query/host-query-key'
import { hostScreenState } from '../query/host-query-screen-state'
import {
  nextBranchCompareState,
  readBranchCompareOutcome,
  type BranchCompareAttempt
} from './mobile-branch-compare-outcome'
import { gitStatusQuery } from './mobile-git-status-query'
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

type BranchCompareParameters = Readonly<Record<string, never>>
const WHOLE_WORKTREE: BranchCompareParameters = {}

const NO_INPUT = {}

export type MobileSourceControlLoaders = {
  screenState: ScreenState
  branchCompareState: MobileBranchCompareState
  setBranchCompareState: (
    next: MobileBranchCompareState | ((prev: MobileBranchCompareState) => MobileBranchCompareState)
  ) => void
  mountedRef: MutableRefObject<boolean>
  setRootRef: (node: View | null) => void
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
  const statusKey = useMemo(
    () => hostQueryKey(hostId, gitStatusQuery.family, target, NO_INPUT),
    [hostId, target]
  )
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
  const [branchCompareState, setBranchCompareState] = useState<MobileBranchCompareState>({
    kind: 'idle'
  })
  const [rebaseBaseRef, setRebaseBaseRef] = useState<string | null>(null)
  const mountedRef = useRef(true)
  const branchCompare = useRef(
    new GenerationScopedRequestOwner<BranchCompareParameters, BranchCompareAttempt>()
  ).current
  // Reset on identity change during render so retained ready state cannot expose another host/worktree for a frame.
  const lastResetIdentityRef = useRef(statusIdentityKey)
  // The status read the compare last ran for; Review's reads wait until Changes is back on top.
  const comparedReadRef = useRef<string | null>(null)
  if (lastResetIdentityRef.current !== statusIdentityKey) {
    lastResetIdentityRef.current = statusIdentityKey
    // Retire before fresh status arrives; otherwise the old compare can publish into the new worktree.
    branchCompare.reset()
    setBranchCompareState({ kind: 'idle' })
    setRebaseBaseRef(null)
  }

  const setRootRef = useCallback(
    (node: View | null): void => {
      if (node !== null) {
        mountedRef.current = true
        return
      }
      // Invalidate route-detached RPC writes without waiting for passive cleanup.
      mountedRef.current = false
      branchCompare.reset()
    },
    [branchCompare]
  )

  const loadBranchCompare = useCallback(
    // The compare base can be the branch's upstream, so it follows the status read that triggered it.
    async (options: { preserveReadyOnFailure: boolean; upstreamName: string | undefined }) => {
      // Each compare refresh owns a fresh reply; retire first so only the newest attempt can publish.
      branchCompare.reset()
      if (!worktreeId || !client || connState !== 'connected') {
        if (mountedRef.current) {
          setBranchCompareState({ kind: 'idle' })
        }
        return false
      }
      // Scope by host and route identity as well as render-time retirement to fence loads that reach the owner first.
      const scope: RequestScope = [client, statusIdentityKey]

      setBranchCompareState((prev) => (prev.kind === 'ready' ? prev : { kind: 'loading' }))
      const loaded = await branchCompare.load(scope, WHOLE_WORKTREE, (currency) =>
        readBranchCompareOutcome(client, worktreeId, currency, {
          compareAgainstUpstream,
          upstreamName: options.upstreamName
        })
      )
      // Mount liveness belongs to the view; a current reply still cannot publish after detach.
      if (!loaded || !mountedRef.current) {
        return false
      }
      if (branchCompare.commit(loaded.lease, loaded.value) !== 'committed') {
        return false
      }
      const outcome = loaded.value
      setRebaseBaseRef(outcome.effectiveBaseRef)
      setBranchCompareState((prev) =>
        nextBranchCompareState(outcome, prev, options.preserveReadyOnFailure)
      )
      return outcome.kind === 'ready'
    },
    [branchCompare, client, compareAgainstUpstream, connState, statusIdentityKey, worktreeId]
  )

  // Each status read that lands, and a new compare setting, refreshes the compare; a read in flight brings its own.
  // Review shares the status entry, so its reads wait until Changes is back on top and then compare once.
  const { data: statusRead, error: statusError, isFetching: statusFetching } = statusQuery
  const compareShownStatus = useEffectEvent(() => {
    const read = `${statusIdentityKey}\0${statusQuery.dataUpdatedAt}\0${compareAgainstUpstream}`
    if (
      focused &&
      comparedReadRef.current !== read &&
      statusRead?.kind === 'ready' &&
      !statusFetching &&
      statusQuery.status === 'success'
    ) {
      comparedReadRef.current = read
      void loadBranchCompare({
        preserveReadyOnFailure: true,
        upstreamName: statusRead.status.upstreamStatus?.upstreamName
      })
    }
  })
  useEffect(() => {
    compareShownStatus()
  }, [statusKey, statusQuery.dataUpdatedAt, statusFetching, compareAgainstUpstream, focused])

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
    setBranchCompareState,
    mountedRef,
    setRootRef,
    loadStatus,
    refreshing: statusQuery.isRefetching,
    settings,
    rebaseBaseRef
  }
}
