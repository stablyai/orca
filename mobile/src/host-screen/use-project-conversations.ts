import {
  refreshProjectConversationHistory,
  type ProjectConversationHistorySnapshot
} from './project-conversation-history-refresh'
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { RpcClient } from '../transport/rpc-client'
import type { ExecutionHostId } from '../../../src/shared/execution-host'
import {
  rpcClientForExecutionHost,
  reachableServerClients
} from '../transport/execution-host-scoped-rpc-client'
import { getWorktreeRowIdentity } from '../worktree/worktree-host-row-identity'
import { resolveWorktreeHostId } from '../worktree/worktree-host-context-labels'
import { sessionTabsListRead } from '../session/mobile-session-read-operations'
import type { HostScreenController } from './use-host-screen-controller'
import {
  readConversationTabs,
  type ConversationHistory,
  type ConversationTab
} from './project-conversations'

type ConversationSnapshot = {
  tabs: Map<string, ConversationTab[]>
  history: ConversationHistory[]
  historyByHost: Map<ExecutionHostId, ProjectConversationHistorySnapshot>
  capabilities: Map<ExecutionHostId, readonly string[]>
  complete: boolean
  failed: boolean
}
const EMPTY: ConversationSnapshot = {
  tabs: new Map(),
  history: [],
  historyByHost: new Map(),
  capabilities: new Map(),
  complete: false,
  failed: false
}

type LoadedConversations = {
  client: RpcClient
  hostId: string | undefined
  generation: number
  authority: string
  workspaceStamp: string
  at: number
  value: ConversationSnapshot
}

const snapshots = new WeakMap<RpcClient, LoadedConversations>()
const REFRESH_MS = 15_000

export type ProjectConversationsSource = Pick<
  HostScreenController,
  'client' | 'hostId' | 'connState' | 'displayWorktrees' | 'hostCapabilities'
> & {
  state: Pick<HostScreenController['state'], 'serverWorkspaces' | 'repoHostIdByRepoId'>
  catalog: Pick<HostScreenController['catalog'], 'onRefresh'>
}

export function useProjectConversations(controller: ProjectConversationsSource) {
  const { client, hostId, connState, displayWorktrees, hostCapabilities, state } = controller
  const subscribe = useCallback(
    (onChange: () => void) => client?.onStateChange(onChange) ?? (() => {}),
    [client]
  )
  const readGeneration = useCallback(() => client?.getGeneration?.() ?? 0, [client])
  const generation = useSyncExternalStore(subscribe, readGeneration, readGeneration)
  const workspaces = useMemo(
    () =>
      displayWorktrees.map((workspace) => ({
        ...workspace,
        hostId: resolveWorktreeHostId(workspace, state.repoHostIdByRepoId)
      })),
    [displayWorktrees, state.repoHostIdByRepoId]
  )
  const workspacesRef = useRef(workspaces)
  workspacesRef.current = workspaces
  const workspaceStamp = workspaces.map(getWorktreeRowIdentity).sort().join('\0')
  const serversRef = useRef(state.serverWorkspaces.hosts)
  serversRef.current = state.serverWorkspaces.hosts
  const serverStamp = state.serverWorkspaces.hosts
    .map((host) => `${host.hostId}:${host.relay}`)
    .join('\0')
  const sources = useMemo(() => {
    const servers = reachableServerClients(client, hostCapabilities, serversRef.current)
    return client ? new Map([['local' as const, client], ...servers]) : servers
  }, [client, hostCapabilities, serverStamp])
  const authority = serverStamp ? JSON.stringify([hostCapabilities, serverStamp]) : ''
  const cached = client ? snapshots.get(client) : undefined
  const belongsHere = (entry: LoadedConversations | null | undefined) =>
    entry?.client === client &&
    entry.hostId === hostId &&
    entry.generation === generation &&
    entry.authority === authority
  const [loaded, setLoaded] = useState<LoadedConversations | null>(null)
  const retained = belongsHere(loaded) ? loaded : belongsHere(cached) ? cached : null
  const [refreshing, setRefreshing] = useState(false)
  const [revision, setRevision] = useState(0)
  const onRefresh = useCallback(() => {
    setRefreshing(true)
    setRevision((value) => value + 1)
    void controller.catalog.onRefresh()
  }, [controller.catalog.onRefresh])

  useEffect(() => {
    if (!client || connState !== 'connected') {
      return
    }
    let stale = false
    let running = false
    let firstRefresh = true
    const cached = snapshots.get(client)
    const fresh =
      cached !== undefined &&
      cached.hostId === hostId &&
      cached.generation === generation &&
      cached.authority === authority &&
      cached.workspaceStamp === workspaceStamp &&
      !cached.value.failed &&
      Date.now() - cached.at < REFRESH_MS
    const current = () => !stale && generation === (client.getGeneration?.() ?? 0)
    const refresh = async () => {
      if (running) {
        return
      }
      running = true
      const force = firstRefresh && revision > 0
      firstRefresh = false
      const previous = snapshots.get(client)
      const sameAuthority =
        previous !== undefined &&
        previous.hostId === hostId &&
        previous.generation === generation &&
        previous.authority === authority
      const failedSources = new Set<ExecutionHostId>()
      const failedTabs = new Set<string>()
      const next: ConversationSnapshot = {
        tabs: new Map(),
        history: [],
        historyByHost: new Map(),
        capabilities: new Map(),
        complete: true,
        failed: false
      }
      try {
        const historyRequests = Promise.all(
          [...sources].map(async ([sourceHost, sourceClient]) => {
            try {
              const { capabilities, history } = await refreshProjectConversationHistory(
                sourceClient,
                force,
                sameAuthority ? previous.value.historyByHost.get(sourceHost) : undefined
              )
              next.capabilities.set(sourceHost, capabilities)
              if (!history) {
                next.complete = false
                return
              }
              next.historyByHost.set(sourceHost, history)
              if (!history.includesStructuredSessions || history.issues.length > 0) {
                next.complete = false
              }
              next.failed ||= history.issues.length > 0
              next.history.push(
                ...history.sessions.map((session) => ({
                  ...session,
                  executionHostId:
                    sourceHost !== 'local' && session.executionHostId === 'local'
                      ? sourceHost
                      : session.executionHostId
                }))
              )
            } catch {
              failedSources.add(sourceHost)
              next.failed = true
              next.complete = false
            }
          })
        )
        const workspaces = workspacesRef.current
        for (let offset = 0; offset < workspaces.length && current(); offset += 4) {
          await Promise.all(
            workspaces.slice(offset, offset + 4).map(async (workspace) => {
              const rowClient = rpcClientForExecutionHost(
                client,
                hostCapabilities,
                workspace.hostId
              )
              if (!rowClient) {
                return
              }
              try {
                const result = sessionTabsListRead.interpret(
                  await sessionTabsListRead.request(rowClient, {
                    worktree: `id:${workspace.worktreeId}`
                  })
                )
                next.tabs.set(getWorktreeRowIdentity(workspace), readConversationTabs(result))
              } catch {
                failedTabs.add(getWorktreeRowIdentity(workspace))
                next.failed = true
              }
            })
          )
        }
        await historyRequests
        if (current()) {
          const value = (() => {
            const tabs = new Map(next.tabs)
            const capabilities = new Map(next.capabilities)
            const historyByHost = new Map(next.historyByHost)
            let history = next.history
            if (sameAuthority) {
              for (const source of failedSources) {
                const priorHistory = previous.value.historyByHost.get(source)
                if (priorHistory) {
                  historyByHost.set(source, priorHistory)
                }
                const retained = previous.value.capabilities.get(source)
                if (!capabilities.has(source) && retained) {
                  capabilities.set(source, retained)
                }
              }
              for (const key of failedTabs) {
                const retained = previous.value.tabs.get(key)
                if (retained) {
                  tabs.set(key, retained)
                }
              }
              history = [
                ...history,
                ...previous.value.history.filter(
                  (session) =>
                    session.executionHostId &&
                    failedSources.has(
                      session.executionHostId.startsWith('runtime:')
                        ? session.executionHostId
                        : 'local'
                    )
                )
              ]
            }
            return { ...next, tabs, capabilities, history, historyByHost }
          })()
          const loaded = {
            client,
            hostId,
            generation,
            authority,
            workspaceStamp,
            at: Date.now(),
            value
          }
          snapshots.set(client, loaded)
          setLoaded(loaded)
        }
      } finally {
        running = false
        if (current()) {
          setRefreshing(false)
        }
      }
    }
    if (!fresh || revision > 0) {
      void refresh()
    }
    const timer = setInterval(() => void refresh(), REFRESH_MS)
    return () => {
      stale = true
      clearInterval(timer)
    }
  }, [
    client,
    connState,
    hostId,
    generation,
    sources,
    workspaceStamp,
    hostCapabilities,
    revision,
    authority
  ])

  const snapshot = retained?.value ?? EMPTY
  return {
    ...snapshot,
    generation,
    workspaces,
    refreshing,
    onRefresh,
    loading: snapshot === EMPTY && connState === 'connected',
    capabilitiesFor: (host: ExecutionHostId) =>
      snapshot.capabilities.get(host.startsWith('runtime:') ? host : 'local') ?? []
  }
}
