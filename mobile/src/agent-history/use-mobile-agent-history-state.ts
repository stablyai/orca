import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore
} from 'react'
import { mobileStructuredSessionStatusFeed } from '../session/mobile-structured-session-status-feed'
import type { AgentSessionConversationNames } from '../../../src/shared/agent-session/agent-session-conversation-names'
import { useForceReconnect } from '../transport/host-client-hooks'
import { useWorkspaceClient } from '../transport/use-workspace-client'
import type { RpcClient } from '../transport/rpc-client'
import { connectionRetryAction } from '../transport/connection-retry-action'
import type { Worktree } from '../worktree/workspace-list-types'
import {
  deriveMobileAiVaultScopePaths,
  mobileAiVaultScanScopePaths,
  mobileAiVaultScopePathsKey,
  resolveActiveHistoryWorktree
} from './agent-history-scope-paths'
import type { AiVaultScope } from '../../../src/shared/ai-vault/contracts/ai-vault-types'
import { useAgentHistoryAssociationReload } from './use-agent-history-association-reload'
import { agentHistoryHostStatusRead } from './mobile-agent-history-operations'
import {
  applyAgentSessionConversationNames,
  readCachedAgentHistorySnapshot,
  readInitialAgentHistoryScreenState,
  readLatestCachedAgentHistorySnapshot,
  scanMobileAgentFirstScreenPreview,
  scanMobileAgentSessions,
  writeCachedAgentHistorySnapshot,
  type AgentHistoryCachedSnapshot,
  type AgentHistoryScreenState,
  type FetchedHistoryState
} from './agent-history-session-scanner'
import { interpretOrThrowRefusalMessage } from '../transport/rpc-refusal-message'
import { MOBILE_AI_VAULT_CAPABILITY } from './agent-history-capability'
import { useMobileTranslation } from '../i18n/use-mobile-translation'

export { MOBILE_AI_VAULT_CAPABILITY }
export type { AgentHistoryScreenState }

const EMPTY_NAMES: AgentSessionConversationNames = new Map()
const noSubscription = () => () => {}
const noNames = () => EMPTY_NAMES
const IS_VITEST = typeof process !== 'undefined' && Boolean(process.env?.VITEST)

export type MobileAgentHistoryStateParams = {
  hostId: string
  worktreeId: string
  worktrees: readonly Worktree[]
  // Distinguish unfetched worktree list from fetched-but-missing workspace; only first holds loading.
  worktreesLoaded: boolean
  fastFirstScreen?: boolean
}

/** Loads one host's agent history and keeps an in-flight scan when a new worktree array has the same paths. */
export function useMobileAgentHistoryState(params: MobileAgentHistoryStateParams) {
  const t = useMobileTranslation()
  const { hostId, worktreeId, worktrees, worktreesLoaded, fastFirstScreen = !IS_VITEST } = params
  const { client, state: connState } = useWorkspaceClient(hostId)
  const forceReconnect = useForceReconnect()
  const [scope, setScope] = useState<AiVaultScope>('workspace')
  const [screenState, setScreenState] = useState<FetchedHistoryState>(() =>
    readInitialAgentHistoryScreenState(hostId, client, connState)
  )
  const clientGeneration = client?.getGeneration?.() ?? 0
  const [hostStatusProbe, setHostStatusProbe] = useState<{
    hostId: string
    client: RpcClient
    generation: number
    result: unknown
  } | null>(null)
  const hostStatusResult =
    connState === 'connected' &&
    hostStatusProbe?.hostId === hostId &&
    hostStatusProbe.client === client &&
    hostStatusProbe.generation === clientGeneration
      ? hostStatusProbe.result
      : null
  const [refreshing, setRefreshing] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const generationRef = useRef(0)
  const mountedRef = useRef(true)
  const lastSnapshotsRef = useRef<Map<string, AgentHistoryCachedSnapshot>>(new Map())

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const activeWorktree = useMemo(
    () => resolveActiveHistoryWorktree(worktrees, worktreeId, fastFirstScreen),
    [fastFirstScreen, worktrees, worktreeId]
  )
  const hasActiveWorktree = activeWorktree !== null
  const effectiveWorktreesLoaded = worktreesLoaded || (fastFirstScreen && hasActiveWorktree)
  // Path keys, not array identity: worktree.ps replaces the array even when every path is unchanged.
  const activeScopePathsKey =
    scope === 'all' ? '' : mobileAiVaultScopePathsKey(scope, activeWorktree, worktrees)
  const scopeContextRef = useRef({ activeWorktree, worktrees })
  scopeContextRef.current = { activeWorktree, worktrees }
  const activeWorktreePath = activeWorktree?.path ?? null
  // Reuse host hint prefixes for client narrowing: host union only widens; All is not narrowed.
  const scopeFilterPaths = useMemo(
    () => deriveMobileAiVaultScopePaths(scope, activeWorktree, worktrees),
    [scope, activeWorktree, worktrees]
  )

  const feed = useMemo(() => (client ? mobileStructuredSessionStatusFeed(client) : null), [client])
  const names = useSyncExternalStore(
    feed?.subscribe ?? noSubscription,
    feed?.getNamingSnapshot ?? noNames,
    noNames
  )
  const identityKey = `${hostId}\0${clientGeneration}\0${connState}\0${worktreeId}\0${hasActiveWorktree}\0${activeScopePathsKey}\0${effectiveWorktreesLoaded}\0${scope}`
  const identity = useMemo(() => ({ client, identityKey }), [client, identityKey])
  const identityRef = useRef(identity)
  useLayoutEffect(() => {
    identityRef.current = identity
  }, [identity])
  const activeLoads = useRef(0)
  const pendingAssociationLoad = useRef<(() => void) | null>(null)

  const loadSessions = useCallback(
    async (options: { scope: AiVaultScope; force: boolean }): Promise<void> => {
      const requestIdentity = identityRef.current
      const associationRevision = feed?.getAssociationRevision()
      const generation = generationRef.current + 1
      generationRef.current = generation
      const isCurrent = () =>
        mountedRef.current &&
        identityRef.current === requestIdentity &&
        associationRevision === feed?.getAssociationRevision() &&
        generationRef.current === generation &&
        (client?.getGeneration?.() ?? 0) === clientGeneration

      if (!client || connState !== 'connected') {
        if (isCurrent()) {
          setHostStatusProbe(null)
          setLoadingMore(false)
          const message = t('agentHistory.useAgentHistoryState.waitingForHost', 'Waiting for host…')
          // Keep stale rows visible during reconnect reloads instead of replacing them with full-screen error, matching host list.
          setScreenState((prev) => (prev.kind === 'ready' ? prev : { kind: 'error', message }))
        }
        return
      }

      const { activeWorktree: scopedWorktree, worktrees: scopedWorktrees } = scopeContextRef.current
      const derivedScopePaths = deriveMobileAiVaultScopePaths(
        options.scope,
        scopedWorktree,
        scopedWorktrees
      )
      const scopePaths = mobileAiVaultScanScopePaths(derivedScopePaths)
      const cacheKey = scopePaths.join('\0')
      const previousSnapshot =
        lastSnapshotsRef.current.get(cacheKey) ?? readCachedAgentHistorySnapshot(hostId, cacheKey)
      setLoadingMore(!options.force && !previousSnapshot)
      setScreenState((prev) => (prev.kind === 'ready' ? prev : { kind: 'loading' }))
      activeLoads.current += 1
      try {
        // Gate capability before calling RPC absent on older hosts.
        const statusReply = await agentHistoryHostStatusRead.request(client)
        if (!isCurrent()) {
          return
        }
        const status = interpretOrThrowRefusalMessage(
          () => agentHistoryHostStatusRead.interpret(statusReply),
          t('agentHistory.useAgentHistoryState.hostUnreachable', 'Unable to reach host')
        )
        setHostStatusProbe({ hostId, client, generation: clientGeneration, result: status })
        if (!status.capabilities?.includes(MOBILE_AI_VAULT_CAPABILITY)) {
          setLoadingMore(false)
          setScreenState({ kind: 'unsupported' })
          return
        }

        // Wait for worktree list before scoped fetch to avoid unrelated history flash; once loaded, proceed even if workspace is missing to avoid stuck spinner.
        if (options.scope !== 'all' && !hasActiveWorktree && !effectiveWorktreesLoaded) {
          if (isCurrent()) {
            setScreenState((prev) => (prev.kind === 'ready' ? prev : { kind: 'loading' }))
          }
          return
        }

        const fallbackErrorMessage = t(
          'agentHistory.useAgentHistoryState.loadFailed',
          'Unable to load agent sessions'
        )
        const warmHostSnapshot = readLatestCachedAgentHistorySnapshot(hostId, client)
        if (!previousSnapshot && !warmHostSnapshot && !options.force && fastFirstScreen) {
          const previewState = await scanMobileAgentFirstScreenPreview(client, {
            hostId,
            scope: options.scope,
            derivedScopePaths,
            fallbackErrorMessage
          })
          if (!isCurrent()) {
            return
          }
          if (previewState) {
            setScreenState(previewState)
          }
        }
        const result = await scanMobileAgentSessions(client, {
          scopePaths,
          force: options.force,
          previous: previousSnapshot,
          fallbackErrorMessage
        })
        if (!isCurrent()) {
          return
        }
        if (result.fingerprint) {
          const snapshot: AgentHistoryCachedSnapshot = {
            fingerprint: result.fingerprint,
            sessions: result.sessions,
            issues: result.issues,
            client
          }
          lastSnapshotsRef.current.set(cacheKey, snapshot)
          writeCachedAgentHistorySnapshot(hostId, cacheKey, snapshot)
        }
        setLoadingMore(false)
        setScreenState({
          kind: 'ready',
          hostId,
          client,
          sessions: result.sessions,
          issues: result.issues
        })
      } catch (err) {
        if (!isCurrent()) {
          return
        }
        const message =
          err instanceof Error
            ? err.message
            : t('agentHistory.useAgentHistoryState.loadFailed', 'Unable to load agent sessions')
        setHostStatusProbe(null)
        setLoadingMore(false)
        setScreenState({ kind: 'error', message })
      } finally {
        activeLoads.current -= 1
        if (activeLoads.current === 0) {
          const followUp = pendingAssociationLoad.current
          pendingAssociationLoad.current = null
          followUp?.()
        }
      }
    },
    [
      activeScopePathsKey,
      client,
      clientGeneration,
      connState,
      fastFirstScreen,
      feed,
      hasActiveWorktree,
      hostId,
      effectiveWorktreesLoaded,
      t
    ]
  )

  // Initial/reconnect/scope loads reuse host’s 15s cache; only explicit refresh bypasses it.
  useEffect(() => {
    void loadSessions({ scope, force: false })
  }, [loadSessions, scope])
  useAgentHistoryAssociationReload(feed, loadSessions, scope, activeLoads, pendingAssociationLoad)

  const onSelectScope = useCallback((nextScope: AiVaultScope) => {
    setScope(nextScope)
  }, [])

  const onRefresh = useCallback(async () => {
    setRefreshing(true)
    try {
      // Refresh with force:true bypasses 15s TTL and joins inflight scan; cached result would show no change.
      await loadSessions({ scope, force: true })
    } finally {
      if (mountedRef.current) {
        setRefreshing(false)
      }
    }
  }, [loadSessions, scope])

  const retry = useMemo(
    () =>
      connectionRetryAction({
        hostId,
        needsReconnect: connState !== 'connected',
        forceReconnect,
        reload: () => void loadSessions({ scope, force: false })
      }),
    [connState, forceReconnect, hostId, loadSessions, scope]
  )

  const namedScreenState = useMemo<AgentHistoryScreenState>(
    () => applyAgentSessionConversationNames(screenState, names, hostId, client),
    [screenState, names, hostId, client]
  )

  return {
    connState,
    scope,
    screenState: namedScreenState,
    refreshing,
    loadingMore,
    hostStatusResult,
    activeWorktreePath,
    scopeFilterPaths,
    onSelectScope,
    onRefresh,
    retry
  }
}

export type MobileAgentHistoryState = ReturnType<typeof useMobileAgentHistoryState>
