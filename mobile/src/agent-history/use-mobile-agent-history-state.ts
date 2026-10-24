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
import { deriveMobileAiVaultScopePaths } from './agent-history-scope-paths'
import {
  agentHistoryHostStatusRead,
  agentHistorySessionScan
} from './mobile-agent-history-operations'
import { interpretOrThrowRefusalMessage } from '../transport/rpc-refusal-message'
import { MOBILE_AI_VAULT_CAPABILITY } from './agent-history-capability'

export { MOBILE_AI_VAULT_CAPABILITY }

// Why: mirror the desktop renderer's SESSION_LIMIT=500. limit caps only the
// global recency list; the in-scope Claude union is capped separately host-side,
// so the response can still be large — hence virtualization + lazy preview.
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
  // Why: distinguishes "worktree list not fetched yet" from "fetched, but this
  // worktree isn't in it" so a scoped tab holds loading only for the former.
  worktreesLoaded: boolean
}

export function useMobileAgentHistoryState(params: MobileAgentHistoryStateParams) {
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
  // Why: the host union only widens, so the screen narrows by these cwd
  // path-prefixes for the current scope (empty for 'all'). Same derivation the
  // RPC scopePaths use, reused client-side for the actual narrowing.
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
          // Why: keep the stale list visible through transient reconnects
          // (connState flips re-run the load effect) instead of tearing it
          // down to a full-screen error, matching the host list screen.
          setScreenState((prev) =>
            prev.kind === 'ready' ? prev : { kind: 'error', message: 'Waiting for host…' }
          )
        }
        return
      }

      setScreenState((prev) => (prev.kind === 'ready' ? prev : { kind: 'loading' }))
      activeLoads.current += 1
      try {
        // Gate on the capability so older hosts lacking the method are detected
        // and we never call a missing RPC.
        const statusReply = await agentHistoryHostStatusRead.request(client)
        if (!isCurrent()) {
          return
        }
        const status = interpretOrThrowRefusalMessage(
          () => agentHistoryHostStatusRead.interpret(statusReply),
          'Unable to reach host'
        )
        setHostStatusProbe({ hostId, client, generation: clientGeneration, result: status })
        if (!status.capabilities?.includes(MOBILE_AI_VAULT_CAPABILITY)) {
          setScreenState({ kind: 'unsupported' })
          return
        }

        // Why: a scoped tab needs the active worktree's path to narrow. Until the
        // worktree list has loaded, hold loading rather than firing an unscoped
        // fetch that would briefly show unrelated host history. Once loaded we
        // proceed even if the worktree isn't found, to avoid a stuck spinner.
        if (options.scope !== 'all' && !activeWorktree && !worktreesLoaded) {
          if (isCurrent()) {
            setScreenState((prev) => (prev.kind === 'ready' ? prev : { kind: 'loading' }))
          }
          return
        }

        const scopePaths = deriveMobileAiVaultScopePaths(options.scope, activeWorktree, worktrees)
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
          'Unable to load agent sessions'
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
        const message = err instanceof Error ? err.message : 'Unable to load agent sessions'
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
    [activeWorktree, client, clientGeneration, connState, feed, hostId, worktrees, worktreesLoaded]
  )

  // Initial + reconnect load. Why: scope switches reuse the host's 15s cache
  // (force:false) so a tab tap is cheap; only an explicit refresh bypasses it.
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
      // Why: pull-to-refresh bypasses the host TTL (force:true) and joins any
      // active inflight scan; otherwise a refresh within 15s shows no change.
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
