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
import type { AgentSessionConversationNames } from '../../../src/shared/agent-session-conversation-names'
import { useForceReconnect } from '../transport/host-client-hooks'
import { useWorkspaceClient } from '../transport/use-workspace-client'
import type { RpcClient } from '../transport/rpc-client'
import { connectionRetryAction } from '../transport/connection-retry-action'
import type {
  AiVaultScanIssue,
  AiVaultScope,
  AiVaultSession
} from '../../../src/shared/ai-vault-types'
import type { Worktree } from '../worktree/workspace-list-types'
import {
  deriveMobileAiVaultScopePaths,
  mobileAiVaultScanScopePaths
} from './agent-history-scope-paths'
import {
  agentHistoryHostStatusRead,
  agentHistorySessionScan
} from './mobile-agent-history-operations'
import { interpretOrThrowRefusalMessage } from '../transport/rpc-refusal-message'
import { MOBILE_AI_VAULT_CAPABILITY } from './agent-history-capability'
import { useMobileTranslation } from '../i18n/use-mobile-translation'

export { MOBILE_AI_VAULT_CAPABILITY }

// Match desktop SESSION_LIMIT=500 for recency only; host separately caps in-scope union, so large responses still need virtualization/lazy previews.
const MOBILE_AI_VAULT_SESSION_LIMIT = 500
const EMPTY_NAMES: AgentSessionConversationNames = new Map()
const noSubscription = () => () => {}
const noNames = () => EMPTY_NAMES

export type AgentHistoryScreenState =
  | { kind: 'loading' }
  | { kind: 'unsupported' }
  | { kind: 'error'; message: string }
  | {
      kind: 'ready'
      sessions: AiVaultSession[]
      issues: AiVaultScanIssue[]
    }

type FetchedHistoryState =
  | Exclude<AgentHistoryScreenState, { kind: 'ready' }>
  | (Extract<AgentHistoryScreenState, { kind: 'ready' }> & { hostId: string; client: RpcClient })

export type MobileAgentHistoryStateParams = {
  hostId: string
  worktreeId: string
  worktrees: readonly Worktree[]
  // Distinguish unfetched worktree list from fetched-but-missing workspace; only first holds loading.
  worktreesLoaded: boolean
}

export function useMobileAgentHistoryState(params: MobileAgentHistoryStateParams) {
  const t = useMobileTranslation()
  const { hostId, worktreeId, worktrees, worktreesLoaded } = params
  const { client, state: connState } = useWorkspaceClient(hostId)
  const forceReconnect = useForceReconnect()
  const [scope, setScope] = useState<AiVaultScope>('workspace')
  const [screenState, setScreenState] = useState<FetchedHistoryState>({ kind: 'loading' })
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
  const generationRef = useRef(0)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const activeWorktree = useMemo(
    () => worktrees.find((worktree) => worktree.worktreeId === worktreeId) ?? null,
    [worktrees, worktreeId]
  )
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

  const identity = useMemo(
    () => ({
      hostId,
      client,
      clientGeneration,
      connState,
      worktreeId,
      worktrees,
      worktreesLoaded,
      scope
    }),
    [hostId, client, clientGeneration, connState, worktreeId, worktrees, worktreesLoaded, scope]
  )
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
          const message = t('agentHistory.useAgentHistoryState.waitingForHost', 'Waiting for host…')
          // Keep stale rows visible during reconnect reloads instead of replacing them with full-screen error, matching host list.
          setScreenState((prev) => (prev.kind === 'ready' ? prev : { kind: 'error', message }))
        }
        return
      }

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
          setScreenState({ kind: 'unsupported' })
          return
        }

        // Wait for worktree list before scoped fetch to avoid unrelated history flash; once loaded, proceed even if workspace is missing to avoid stuck spinner.
        if (options.scope !== 'all' && !activeWorktree && !worktreesLoaded) {
          if (isCurrent()) {
            setScreenState((prev) => (prev.kind === 'ready' ? prev : { kind: 'loading' }))
          }
          return
        }

        const scopePaths = mobileAiVaultScanScopePaths(
          deriveMobileAiVaultScopePaths(options.scope, activeWorktree, worktrees)
        )
        const reply = await agentHistorySessionScan.request(client, {
          limit: MOBILE_AI_VAULT_SESSION_LIMIT,
          force: options.force,
          scopePaths
        })
        if (!isCurrent()) {
          return
        }
        const result = interpretOrThrowRefusalMessage(
          () => agentHistorySessionScan.interpret(reply),
          t('agentHistory.useAgentHistoryState.loadFailed', 'Unable to load agent sessions')
        )
        setScreenState({
          kind: 'ready',
          hostId,
          client,
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the reader checks both containers; the rows stay the host's own records because `agent` is a vocabulary this client echoes back on resume. aivault-history-screen-listed `normal` records a full row: every member the cards and the resume path read unguarded.
          sessions: result.sessions as AiVaultSession[],
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: same reader, same container check; the issue rows are the host's AiVaultScanIssue and are only counted, never read member-wise (MobileAgentSessionHistoryPanel.tsx:335).
          issues: result.issues as AiVaultScanIssue[]
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
      activeWorktree,
      client,
      clientGeneration,
      connState,
      feed,
      hostId,
      worktrees,
      worktreesLoaded,
      t
    ]
  )

  // Initial/reconnect/scope loads reuse host’s 15s cache; only explicit refresh bypasses it.
  useEffect(() => {
    void loadSessions({ scope, force: false })
  }, [loadSessions, scope])

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
        pendingAssociationLoad.current = reload
      } else {
        reload()
      }
    })
    return () => {
      stop()
      pendingAssociationLoad.current = null
    }
  }, [feed, loadSessions, scope])

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

  const namedScreenState = useMemo<AgentHistoryScreenState>(() => {
    if (screenState.kind !== 'ready') {
      return screenState
    }
    const current = screenState.hostId === hostId && screenState.client === client
    return {
      kind: 'ready',
      issues: screenState.issues,
      sessions: current
        ? screenState.sessions.map((session) => {
            const id = session.structuredSession?.sessionId
            const title = id ? names.get(id)?.conversationName : null
            return title ? { ...session, title } : session
          })
        : screenState.sessions
    }
  }, [screenState, names, hostId, client])

  return {
    connState,
    scope,
    screenState: namedScreenState,
    refreshing,
    hostStatusResult,
    activeWorktreePath,
    scopeFilterPaths,
    onSelectScope,
    onRefresh,
    retry
  }
}

export type MobileAgentHistoryState = ReturnType<typeof useMobileAgentHistoryState>
