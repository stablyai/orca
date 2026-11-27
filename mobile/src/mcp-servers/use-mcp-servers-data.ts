// What the MCP servers screens read from the host: its list, the servers in its agents' own settings,
// its installed agents and workspaces, and the CLI's check of servers Orca doesn't sign in to. The
// list re-reads on the host's notice, on focus and after every change, since a relayed host's
// notice may not reach the phone.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useFocusEffect } from 'expo-router'
import type { BotToolProblem } from '../../../src/shared/bot-tools'
import {
  getRepoExecutionHostId,
  LOCAL_EXECUTION_HOST_ID
} from '../../../src/shared/execution-host/execution-host'
import { getRuntimePathBasename } from '../../../src/shared/file-access/cross-platform-path'
import { MOBILE_AGENT_CATALOG } from '../agents/mobile-agent-catalog'
import {
  HOST_LIST_TARGET,
  hostRepoCatalogQuery,
  NO_HOST_LIST_INPUT
} from '../host-screen/catalog/host-list-queries'
import { defineHostQuery, useHostQuery } from '../query/host-query'
import { hostQueryKey } from '../query/host-query-key'
import { refetchHostQueryAfterInFlight } from '../query/host-event-router'
import { preflightDetectAgentsRead } from '../session/agent-launch/mobile-agent-detection-operations'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import {
  isMcpMethodNotYet,
  mcpFolderWorkspacesRead,
  mcpServerProblemsCancel,
  mcpServerProblemsRead,
  mcpServersDiscoverRead,
  mcpServersListRead,
  type PhoneMcpServer,
  type PhoneMcpServerList
} from './mcp-server-operations'

const mcpServersQuery = defineHostQuery<typeof NO_HOST_LIST_INPUT, PhoneMcpServerList>({
  family: 'mcpServers.list',
  fetch: async (client) =>
    mcpServersListRead.interpret(await mcpServersListRead.request(client, {})),
  staleTime: 0,
  gcTime: 5 * 60_000,
  refetchOnWindowFocus: true,
  signal: { events: ['mcpServersChanged'] }
})

// Null: the host can't list them yet (a later Orca adds it), so the section stays hidden.
const discoveredQuery = defineHostQuery({
  family: 'mcpServers.discover',
  fetch: async (client) => {
    try {
      return mcpServersDiscoverRead.interpret(await mcpServersDiscoverRead.request(client, {}))
        .servers
    } catch (error) {
      if (isMcpMethodNotYet(error)) {
        return null
      }
      throw error
    }
  },
  staleTime: 0,
  gcTime: 5 * 60_000,
  signal: { events: ['mcpServersChanged'] }
})

// Installs rarely change; the new-tab picker reads them as rarely. Servers apply to the agents in
// the configured Windows Agent runtime, as on desktop; older hosts ignore the flag (native).
const agentsQuery = defineHostQuery({
  family: 'mcpServers.agents',
  fetch: async (client) => {
    const detected = new Set(
      preflightDetectAgentsRead.interpret(
        await preflightDetectAgentsRead.request(client, { configuredWindowsRuntime: true })
      )
    )
    return MOBILE_AGENT_CATALOG.filter((agent) => detected.has(agent.id)).map((agent) => agent.id)
  },
  staleTime: 10 * 60_000,
  gcTime: 30 * 60_000
})

// A folder workspace made on the desktop is announced as a repos change.
const foldersQuery = defineHostQuery({
  family: 'mcpServers.folders',
  fetch: async (client) =>
    mcpFolderWorkspacesRead.interpret(await mcpFolderWorkspacesRead.request(client))
      .folderWorkspaces,
  staleTime: 60_000,
  gcTime: 5 * 60_000,
  signal: { events: ['reposChanged'] }
})

/** A workspace a server can be limited to: a repo by its id, a folder as `folder:<id>`. */
export type McpWorkspace = { key: string; name: string; folder: boolean }

export function useMcpServersData(hostId: string, client: RpcClient | null, enabled: boolean) {
  const host = { hostId, client }
  const queryClient = useQueryClient()
  const options = { enabled }
  const list = useHostQuery(mcpServersQuery, host, HOST_LIST_TARGET, NO_HOST_LIST_INPUT, options)
  const discovered = useHostQuery(
    discoveredQuery,
    host,
    HOST_LIST_TARGET,
    NO_HOST_LIST_INPUT,
    options
  )
  const agents = useHostQuery(agentsQuery, host, HOST_LIST_TARGET, NO_HOST_LIST_INPUT, options)
  const repos = useHostQuery(
    hostRepoCatalogQuery,
    host,
    HOST_LIST_TARGET,
    NO_HOST_LIST_INPUT,
    options
  )
  const folders = useHostQuery(foldersQuery, host, HOST_LIST_TARGET, NO_HOST_LIST_INPUT, options)

  const { refetch: refetchList } = list
  const { refetch: refetchDiscovered } = discovered
  const { refetch: refetchAgents } = agents
  // A host without the capability is never asked, even on focus.
  const reread = useCallback(() => {
    if (enabled) {
      // Joins a read already out (the mount's, or the host's notice) instead of sending another.
      void refetchList({ cancelRefetch: false })
      void refetchDiscovered({ cancelRefetch: false })
      // A failed read (a stopped WSL distro) is retried on focus; a held list keeps its long cache.
      // Read here, not as a dependency, so the error itself cannot re-run this focus callback.
      const agentsKey = hostQueryKey(
        hostId,
        agentsQuery.family,
        HOST_LIST_TARGET,
        NO_HOST_LIST_INPUT
      )
      if (queryClient.getQueryState(agentsKey)?.status === 'error') {
        void refetchAgents({ cancelRefetch: false })
      }
    }
  }, [enabled, refetchList, refetchDiscovered, queryClient, hostId, refetchAgents])
  useFocusEffect(reread)

  /** A change's answer shows at once; the re-read after it catches what else changed. */
  const applyServer = useCallback(
    (server: PhoneMcpServer | null, removedId?: string) => {
      const key = hostQueryKey(hostId, mcpServersQuery.family, HOST_LIST_TARGET, NO_HOST_LIST_INPUT)
      queryClient.setQueryData<PhoneMcpServerList>(key, (held) => {
        if (!held) {
          return held
        }
        const rest = held.servers.filter((entry) => entry.id !== (server?.id ?? removedId))
        const at = held.servers.findIndex((entry) => entry.id === server?.id)
        const servers = server
          ? at === -1
            ? [...rest, server]
            : held.servers.map((entry) => (entry.id === server.id ? server : entry))
          : rest
        return { ...held, servers }
      })
      // A read already out may predate this change, so read again once it lands, never join it.
      for (const family of [mcpServersQuery.family, discoveredQuery.family]) {
        const query = queryClient.getQueryCache().find({
          queryKey: hostQueryKey(hostId, family, HOST_LIST_TARGET, NO_HOST_LIST_INPUT),
          exact: true
        })
        if (query) {
          refetchHostQueryAfterInFlight(queryClient, query)
        }
      }
    },
    [hostId, queryClient]
  )

  const workspaces = useMemo((): McpWorkspace[] => {
    const local = (repos.data?.catalog ?? []).filter(
      (repo) => getRepoExecutionHostId(repo) === LOCAL_EXECUTION_HOST_ID
    )
    return [
      ...local.map((repo) => ({ key: repo.id, name: repo.displayName, folder: false })),
      ...(folders.data ?? [])
        .filter((folder) => !folder.connectionId && !folder.executionHostId && !folder.isArchived)
        .map((folder) => ({
          key: `folder:${folder.id}`,
          name: folder.name || getRuntimePathBasename(folder.folderPath),
          folder: true
        }))
    ]
  }, [repos.data, folders.data])

  const problems = useMcpServerProblems(client, list.data?.servers ?? null)

  return {
    list: list.data ?? null,
    listError: list.error,
    loading: list.isPending,
    discovered: discovered.data ?? null,
    agents: agents.data ?? null,
    agentsFailed: agents.isError,
    workspaces,
    problems,
    reread,
    applyServer
  }
}

/** The CLI's check, which starts the servers, so it runs once the page lists them and stops when it closes. */
function useMcpServerProblems(
  client: RpcClient | null,
  servers: readonly PhoneMcpServer[] | null
): Readonly<Record<string, BotToolProblem>> {
  const [problems, setProblems] = useState<Readonly<Record<string, BotToolProblem>>>({})
  // Checked again only when a server comes or goes, never on a switch.
  const ids = servers
    ?.filter((server) => !server.signIn)
    .map((server) => server.id)
    .join('\0')
  const ran = useRef<string | null>(null)
  useEffect(() => {
    if (!client || ids === undefined || ids === '' || ran.current === ids) {
      return undefined
    }
    ran.current = ids
    let live = true
    void mcpServerProblemsRead
      .request(client, {}, { timeoutMs: 120_000 })
      .then((reply) => {
        if (live) {
          setProblems(mcpServerProblemsRead.interpret(reply).problems)
        }
      })
      .catch(() => {})
    return () => {
      live = false
      ran.current = null
      void mcpServerProblemsCancel.request(client, {}).catch(() => {})
    }
  }, [client, ids])
  return problems
}
