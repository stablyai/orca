import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useHostClient, useForceReconnect } from '../transport/client-context'
import type { RpcSuccess } from '../transport/types'
import type {
  AiVaultListResult,
  AiVaultScanIssue,
  AiVaultScope,
  AiVaultSession
} from '../../../src/shared/ai-vault-types'
import type { Worktree } from '../worktree/workspace-list-types'
import { deriveMobileAiVaultScopePaths } from './agent-history-scope-paths'
import { MOBILE_AI_VAULT_CAPABILITY } from './agent-history-capability'

export { MOBILE_AI_VAULT_CAPABILITY }

// Why: mirror the desktop renderer's SESSION_LIMIT=500. limit caps only the
// global recency list; the in-scope Claude union is capped separately host-side,
// so the response can still be large — hence virtualization + lazy preview.
const MOBILE_AI_VAULT_SESSION_LIMIT = 500

export type AgentHistoryScreenState =
  | { kind: 'loading' }
  | { kind: 'unsupported' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; sessions: AiVaultSession[]; issues: AiVaultScanIssue[] }

type StatusWithCapabilities = { capabilities?: string[] }

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
  const { client, state: connState } = useHostClient(hostId)
  const forceReconnect = useForceReconnect()
  const [scope, setScope] = useState<AiVaultScope>('workspace')
  const [screenState, setScreenState] = useState<AgentHistoryScreenState>({ kind: 'loading' })
  const [hostStatusResult, setHostStatusResult] = useState<unknown>(null)
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
      const isCurrent = () => mountedRef.current && generationRef.current === generation

      if (!client || connState !== 'connected') {
        if (isCurrent()) {
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
      try {
        // Gate on the capability so older hosts lacking the method are detected
        // and we never call a missing RPC.
        const statusResponse = await client.sendRequest('status.get')
        if (!isCurrent()) {
          return
        }
        if (!statusResponse.ok) {
          throw new Error(statusResponse.error?.message || 'Unable to reach host')
        }
        const status = (statusResponse as RpcSuccess).result as StatusWithCapabilities
        setHostStatusResult(status)
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
        const response = await client.sendRequest('aiVault.listSessions', {
          limit: MOBILE_AI_VAULT_SESSION_LIMIT,
          force: options.force,
          scopePaths
        })
        if (!isCurrent()) {
          return
        }
        if (!response.ok) {
          throw new Error(response.error?.message || 'Unable to load agent sessions')
        }
        const result = (response as RpcSuccess).result as AiVaultListResult
        setScreenState({ kind: 'ready', sessions: result.sessions, issues: result.issues })
      } catch (err) {
        if (!isCurrent()) {
          return
        }
        const message = err instanceof Error ? err.message : 'Unable to load agent sessions'
        setHostStatusResult(null)
        setScreenState({ kind: 'error', message })
      }
    },
    [activeWorktree, client, connState, worktrees, worktreesLoaded]
  )

  // Initial + reconnect load. Why: scope switches reuse the host's 15s cache
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
      // active inflight scan; otherwise a refresh within 15s shows no change.
      await loadSessions({ scope, force: true })
    } finally {
      if (mountedRef.current) {
        setRefreshing(false)
      }
    }
  }, [loadSessions, scope])

  const retry = useCallback(() => {
    if (connState !== 'connected' && hostId) {
      void forceReconnect(hostId)
      return
    }
    void loadSessions({ scope, force: false })
  }, [connState, forceReconnect, hostId, loadSessions, scope])

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
