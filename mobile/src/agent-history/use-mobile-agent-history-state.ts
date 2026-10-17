import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useForceReconnect } from '../transport/client-context'
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
import {
  canPaintMobileAiVaultCache,
  clearMobileAiVaultMemoryCache,
  executeMobileAiVaultPlan,
  getMobileAiVaultCacheKey,
  MOBILE_AI_VAULT_INITIAL_LIMIT,
  MOBILE_AI_VAULT_SESSION_LIMIT,
  planMobileAiVaultLoad,
  readMobileAiVaultCache,
  type MobileAiVaultCacheEntry,
  type MobileAiVaultScanReply
} from './mobile-ai-vault-session-cache'

export { MOBILE_AI_VAULT_CAPABILITY }
export {
  MOBILE_AI_VAULT_INITIAL_LIMIT,
  MOBILE_AI_VAULT_SESSION_LIMIT,
  clearMobileAiVaultMemoryCache,
  getMobileAiVaultCacheKey,
  type MobileAiVaultCacheEntry
}

export type AgentHistoryScreenState =
  | { kind: 'loading' }
  | { kind: 'unsupported' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; sessions: AiVaultSession[]; issues: AiVaultScanIssue[] }

export type MobileAgentHistoryStateParams = {
  hostId: string
  worktreeId: string
  worktrees: readonly Worktree[]
  // Why: distinguishes "worktree list not fetched yet" from "fetched, but this
  // worktree isn't in it" so a scoped tab holds loading only for the former.
  worktreesLoaded: boolean
}

function initialScreenState(params: MobileAgentHistoryStateParams): AgentHistoryScreenState {
  const scope: AiVaultScope = 'workspace'
  const activeWorktree = params.worktrees.find((worktree) => worktree.worktreeId === params.worktreeId)
  const scopeFilterPaths = deriveMobileAiVaultScopePaths(scope, activeWorktree ?? null, params.worktrees)
  if (!canPaintMobileAiVaultCache(scope, scopeFilterPaths)) {
    return { kind: 'loading' }
  }
  const cached = readMobileAiVaultCache(
    getMobileAiVaultCacheKey(params.hostId, params.worktreeId, scope)
  )
  if (!cached) {
    return { kind: 'loading' }
  }
  return { kind: 'ready', sessions: cached.sessions, issues: cached.issues }
}

function publishReady(
  entry: MobileAiVaultCacheEntry
): Extract<AgentHistoryScreenState, { kind: 'ready' }> {
  return { kind: 'ready', sessions: entry.sessions, issues: entry.issues }
}

export function useMobileAgentHistoryState(params: MobileAgentHistoryStateParams) {
  const { hostId, worktreeId, worktrees, worktreesLoaded } = params
  const { client, state: connState } = useWorkspaceClient(hostId)
  const forceReconnect = useForceReconnect()
  const [scope, setScope] = useState<AiVaultScope>('workspace')
  const [screenState, setScreenState] = useState<AgentHistoryScreenState>(() =>
    initialScreenState(params)
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

  const loadSessions = useCallback(
    async (options: { scope: AiVaultScope; force: boolean }): Promise<void> => {
      const generation = generationRef.current + 1
      generationRef.current = generation
      const isCurrent = () =>
        mountedRef.current &&
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

      const cacheKey = getMobileAiVaultCacheKey(hostId, worktreeId, options.scope)
      const cached = readMobileAiVaultCache(cacheKey)
      const pendingScopePaths = deriveMobileAiVaultScopePaths(
        options.scope,
        activeWorktree,
        worktrees
      )
      if (cached && canPaintMobileAiVaultCache(options.scope, pendingScopePaths) && isCurrent()) {
        setScreenState(publishReady(cached))
      } else if (isCurrent()) {
        setScreenState((prev) => (prev.kind === 'ready' ? prev : { kind: 'loading' }))
      }

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
        const plan = planMobileAiVaultLoad(cached, options.force)
        const scan = async (args: {
          limit: number
          force: boolean
          afterFingerprint: string | null
        }): Promise<MobileAiVaultScanReply> => {
          const reply = await agentHistorySessionScan.request(client, {
            limit: args.limit,
            force: args.force,
            scopePaths,
            afterFingerprint: args.afterFingerprint
          })
          if (!isCurrent()) {
            return { sessions: [], issues: [] }
          }
          return interpretOrThrowRefusalMessage(
            () => agentHistorySessionScan.interpret(reply),
            'Unable to load agent sessions'
          )
        }
        await executeMobileAiVaultPlan({
          cacheKey,
          cached,
          plan,
          isCurrent,
          scan,
          onPublish: (entry) => setScreenState(publishReady(entry))
        })
      } catch (err) {
        if (!isCurrent()) {
          return
        }
        const message = err instanceof Error ? err.message : 'Unable to load agent sessions'
        // Why: background SWR/stage failures must not blank a list the user already sees.
        setScreenState((prev) =>
          !options.force && prev.kind === 'ready' ? prev : { kind: 'error', message }
        )
        setHostStatusProbe(null)
      }
    },
    [activeWorktree, client, clientGeneration, connState, hostId, worktreeId, worktrees, worktreesLoaded]
  )

  // Initial + reconnect load. Why: scope switches reuse the host's scan cache
  // (force:false) so a tab tap is cheap; only an explicit refresh bypasses it.
  useEffect(() => {
    void loadSessions({ scope, force: false })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- scope handled by onSelectScope
  }, [loadSessions])

  const onSelectScope = useCallback(
    (nextScope: AiVaultScope) => {
      setScope(nextScope)
      void loadSessions({ scope: nextScope, force: false })
    },
    [loadSessions]
  )

  const onRefresh = useCallback(async () => {
    setRefreshing(true)
    try {
      // Why: pull-to-refresh bypasses the host TTL (force:true) and joins any
      // active inflight scan; otherwise a refresh within the TTL shows no change.
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

  return {
    connState,
    scope,
    screenState,
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
