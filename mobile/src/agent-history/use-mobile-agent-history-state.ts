import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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

// Match desktop SESSION_LIMIT=500 for recency only; host separately caps in-scope union, so large responses still need virtualization/lazy previews.
const MOBILE_AI_VAULT_SESSION_LIMIT = 500

export type AgentHistoryScreenState =
  | { kind: 'loading' }
  | { kind: 'unsupported' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; sessions: AiVaultSession[]; issues: AiVaultScanIssue[] }

export type MobileAgentHistoryStateParams = {
  hostId: string
  worktreeId: string
  worktrees: readonly Worktree[]
  // Distinguish unfetched worktree list from fetched-but-missing workspace; only first holds loading.
  worktreesLoaded: boolean
}

export function useMobileAgentHistoryState(params: MobileAgentHistoryStateParams) {
  const { hostId, worktreeId, worktrees, worktreesLoaded } = params
  const { client, state: connState } = useWorkspaceClient(hostId)
  const forceReconnect = useForceReconnect()
  const [scope, setScope] = useState<AiVaultScope>('workspace')
  const [screenState, setScreenState] = useState<AgentHistoryScreenState>({ kind: 'loading' })
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
  // Reuse host hint prefixes for client narrowing: host union only widens, and All leaves prefixes empty.
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
          // Keep stale rows visible during reconnect reloads instead of replacing them with full-screen error, matching host list.
          setScreenState((prev) =>
            prev.kind === 'ready' ? prev : { kind: 'error', message: 'Waiting for host…' }
          )
        }
        return
      }

      setScreenState((prev) => (prev.kind === 'ready' ? prev : { kind: 'loading' }))
      try {
        // Gate capability before calling RPC absent on older hosts.
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

        // Wait for worktree list before scoped fetch to avoid unrelated history flash; once loaded, proceed even if workspace is missing to avoid stuck spinner.
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
      }
    },
    [activeWorktree, client, clientGeneration, connState, hostId, worktrees, worktreesLoaded]
  )

  // Initial/reconnect/scope loads reuse host’s 15s cache; only explicit refresh bypasses it.
  useEffect(() => {
    void loadSessions({ scope, force: false })
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
