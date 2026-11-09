import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { mobileStructuredSessionStatusFeed } from '../session/mobile-structured-session-status-feed'
import type { AgentSessionConversationNames } from '../../../src/shared/agent-session/agent-session-conversation-names'
import { useForceReconnect } from '../transport/connection/host-client-hooks'
import { useWorkspaceClient } from '../worktree/use-workspace-client'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import { connectionRetryAction } from '../transport/connection/connection-retry-action'
import type {
  AiVaultScanIssue,
  AiVaultScope,
  AiVaultSession
} from '../../../src/shared/ai-vault/contracts/ai-vault-types'
import type { Worktree } from '../worktree/workspace-list-types'
import { useWorkspaceExecutionHost } from '../navigation/workspace-execution-host'
import { defineHostQuery, readHostQueryLive, useHostQuery } from '../query/host-query'
import { hostScreenState } from '../query/host-query-screen-state'
import {
  deriveMobileAiVaultScopePaths,
  mobileAiVaultScanScopeArgs
} from './agent-history-scope-paths'
import {
  agentHistoryCapabilityRead,
  agentHistorySessionScan
} from './mobile-agent-history-operations'
import { interpretOrThrowRefusalMessage } from '../transport/rpc/rpc-refusal-message'
import { MOBILE_AI_VAULT_CAPABILITY } from './agent-history-capability'
import { translate } from '../i18n/mobile-i18n'
import { useMobileTranslation } from '../i18n/use-mobile-translation'

export { MOBILE_AI_VAULT_CAPABILITY }

// Match desktop SESSION_LIMIT=500 for recency only; host separately caps in-scope union, so large responses still need virtualization/lazy previews.
const MOBILE_AI_VAULT_SESSION_LIMIT = 500
const HISTORY_FAMILY = 'aiVault.listSessions'
const EMPTY_NAMES: AgentSessionConversationNames = new Map()
const noSubscription = () => () => {}
const noNames = () => EMPTY_NAMES
const noRevision = () => 0

export type AgentHistoryScreenState =
  | { kind: 'loading' }
  | { kind: 'unsupported' }
  | { kind: 'error'; message: string }
  | {
      kind: 'ready'
      sessions: AiVaultSession[]
      issues: AiVaultScanIssue[]
    }

// Rows keep the scope paths they were scanned for, so a revisit filters them before worktree.ps lands.
type AgentHistoryRead =
  | { kind: 'unsupported' }
  | {
      kind: 'ready'
      sessions: AiVaultSession[]
      issues: AiVaultScanIssue[]
      scopeFilterPaths: string[]
      activeWorktreePath: string | null
      // The status feed's association revision when the scan started; a later one makes these rows stale.
      associationRevision: number
    }

type ScanScope = { scopeFilterPaths: string[]; activeWorktreePath: string | null }

async function readAgentHistory(
  client: RpcClient,
  scope: AiVaultScope,
  scan: ScanScope,
  force: boolean,
  associationRevision: number
): Promise<AgentHistoryRead> {
  // Gate capability before calling RPC absent on older hosts.
  const statusReply = await agentHistoryCapabilityRead.request(client)
  const status = interpretOrThrowRefusalMessage(
    () => agentHistoryCapabilityRead.interpret(statusReply),
    translate('agentHistory.useAgentHistoryState.hostUnreachable', 'Unable to reach host')
  )
  if (!status.capabilities?.includes(MOBILE_AI_VAULT_CAPABILITY)) {
    return { kind: 'unsupported' }
  }
  const reply = await agentHistorySessionScan.request(client, {
    limit: MOBILE_AI_VAULT_SESSION_LIMIT,
    force,
    // From the query's own scope key, so rows cached under Workspace are always Workspace-only ones.
    ...mobileAiVaultScanScopeArgs(scope, scan.scopeFilterPaths)
  })
  const result = interpretOrThrowRefusalMessage(
    () => agentHistorySessionScan.interpret(reply),
    translate('agentHistory.useAgentHistoryState.loadFailed', 'Unable to load agent sessions')
  )
  return {
    kind: 'ready',
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the reader checks both containers; the rows stay the host's own records because `agent` is a vocabulary this client echoes back on resume. aivault-history-screen-listed `normal` records a full row: every member the cards and the resume path read unguarded.
    sessions: result.sessions as AiVaultSession[],
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: same reader, same container check; the issue rows are the host's AiVaultScanIssue, classified by `kind` like desktop History (an unknown kind still reads as a notice).
    issues: result.issues as AiVaultScanIssue[],
    ...scan,
    associationRevision
  }
}

// Keyed by workspace and scope, not scan paths: those need worktree.ps, and a revisit paints before it lands.
// Initial/revisit loads reuse host's 15s cache; only explicit refresh sends force.
function agentHistoryQuery(
  scan: ScanScope,
  force: boolean,
  startRevision: (scope: AiVaultScope) => number
) {
  return defineHostQuery({
    family: HISTORY_FAMILY,
    staleTime: 30_000,
    // No desktop signal for new transcripts, so foreground revalidates once older than 30 s.
    refetchOnWindowFocus: true,
    fetch: (client, _target, input: { scope: AiVaultScope }) =>
      readAgentHistory(client, input.scope, scan, force, startRevision(input.scope))
  })
}

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
  const queryClient = useQueryClient()
  const exec = useWorkspaceExecutionHost() ?? 'local'
  const [scope, setScope] = useState<AiVaultScope>('workspace')
  const [refreshing, setRefreshing] = useState(false)

  const activeWorktree = useMemo(
    () => worktrees.find((worktree) => worktree.worktreeId === worktreeId) ?? null,
    [worktrees, worktreeId]
  )
  const liveScan = useMemo(
    (): ScanScope => ({
      // Reuse host hint prefixes for client narrowing: host union only widens; All is not narrowed.
      scopeFilterPaths: deriveMobileAiVaultScopePaths(scope, activeWorktree, worktrees),
      activeWorktreePath: activeWorktree?.path ?? null
    }),
    [scope, activeWorktree, worktrees]
  )
  // Subscribed before the query so the feed's stream opens ahead of the first read, on the page bridge as natively.
  const feed = useMemo(() => (client ? mobileStructuredSessionStatusFeed(client) : null), [client])
  const names = useSyncExternalStore(
    feed?.subscribe ?? noSubscription,
    feed?.getNamingSnapshot ?? noNames,
    noNames
  )
  const associationRevision = useSyncExternalStore(
    feed?.subscribe ?? noSubscription,
    feed?.getAssociationRevision ?? noRevision,
    noRevision
  )
  // The revision each scope's latest read started at, kept whether that read lands or fails.
  const startedRef = useRef(new Map<AiVaultScope, number>())
  const startRevision = useCallback(
    (forScope: AiVaultScope) => {
      const revision = feed?.getAssociationRevision() ?? 0
      startedRef.current.set(forScope, revision)
      return revision
    },
    [feed]
  )
  const historyQuery = useMemo(
    () => agentHistoryQuery(liveScan, false, startRevision),
    [liveScan, startRevision]
  )
  const target = useMemo(() => ({ exec, worktree: worktreeId }), [exec, worktreeId])
  const input = useMemo(() => ({ scope }), [scope])
  const host = useMemo(() => ({ hostId, client }), [hostId, client])
  // Wait for worktree list before fetching to avoid unrelated history; once loaded, proceed even if workspace is missing.
  // Not gated on the connection: the query keeps its connected-edge watcher, and a read while down fails fast.
  const enabled = client !== null && worktreesLoaded
  const result = useHostQuery(historyQuery, host, target, input, { enabled })
  const { data: read, error, isFetching, isRefetching, refetch } = result

  // A changed association moves rows between providers and chats: a scope whose last read started before it
  // reads again once nothing is out. Cached rows from an earlier visit carry their own start revision.
  const cachedRevision = read?.kind === 'ready' ? read.associationRevision : undefined
  useEffect(() => {
    const started = startedRef.current.get(scope) ?? cachedRevision
    const canRead = enabled && connState === 'connected'
    if (canRead && !isFetching && started !== undefined && started !== associationRevision) {
      void refetch()
    }
  }, [enabled, connState, isFetching, scope, cachedRevision, associationRevision, refetch])

  const onSelectScope = useCallback((nextScope: AiVaultScope) => {
    setScope(nextScope)
  }, [])

  const onRefresh = useCallback(async () => {
    // Before worktree.ps lands the scan has no scope paths, and would cache every workspace's rows as this scope's.
    if (!client || connState !== 'connected' || !worktreesLoaded) {
      return
    }
    setRefreshing(true)
    try {
      // force:true bypasses the host's 15s TTL and joins its inflight scan; a cached result would show no change.
      const forced = agentHistoryQuery(liveScan, true, startRevision)
      await readHostQueryLive(queryClient, forced, { hostId, client }, target, input, {
        replace: true
      })
    } catch {
      // The query keeps its rows and records the error.
    } finally {
      setRefreshing(false)
    }
  }, [
    client,
    connState,
    hostId,
    input,
    liveScan,
    queryClient,
    startRevision,
    target,
    worktreesLoaded
  ])

  const retry = useMemo(
    () =>
      connectionRetryAction({
        hostId,
        needsReconnect: connState !== 'connected',
        forceReconnect,
        reload: () => void refetch()
      }),
    [connState, forceReconnect, hostId, refetch]
  )

  const screenState = useMemo((): AgentHistoryScreenState => {
    if (read?.kind === 'unsupported') {
      return read
    }
    if (read) {
      return {
        kind: 'ready',
        issues: read.issues,
        sessions: read.sessions.map((session) => {
          const id = session.structuredSession?.sessionId
          const title = id ? names.get(id)?.conversationName : null
          return title ? { ...session, title } : session
        })
      }
    }
    switch (hostScreenState({ data: read, error, isFetching }, connState)) {
      case 'empty-error':
        return {
          kind: 'error',
          message:
            error?.message ||
            t('agentHistory.useAgentHistoryState.loadFailed', 'Unable to load agent sessions')
        }
      case 'empty-offline':
      case 'empty-connecting':
        if (connState !== 'connected') {
          return {
            kind: 'error',
            message: t('agentHistory.useAgentHistoryState.waitingForHost', 'Waiting for host…')
          }
        }
        return { kind: 'loading' }
      case 'data':
      case 'empty-loading':
        return { kind: 'loading' }
    }
  }, [read, names, error, isFetching, connState, t])

  // Until worktree.ps lands, the cached rows' own scope stands in for the live one.
  const shownScan = !worktreesLoaded && read?.kind === 'ready' ? read : liveScan

  return {
    connState,
    scope,
    screenState,
    refreshing,
    // Shown rows are being re-read in the background; feeds the header's refresh line.
    revalidating: isRefetching && !refreshing,
    activeWorktreePath: shownScan.activeWorktreePath,
    scopeFilterPaths: shownScan.scopeFilterPaths,
    onSelectScope,
    onRefresh,
    retry
  }
}

export type MobileAgentHistoryState = ReturnType<typeof useMobileAgentHistoryState>
