import { useMemo } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { AgentSessionModelCatalogResult } from '../../../src/shared/agent-session/agent-session-wire'
import {
  hostReadsSavedModelCatalogsOnly,
  selectHostModelCatalogSnapshot,
  withHostModelCatalogAnswer,
  type HostModelCatalogSnapshot
} from '../../../src/shared/agent-session/options/host-model-catalog-snapshot-rules'
import { defineHostQuery, useHostQuery } from '../query/host-query'
import { hostQueryKey } from '../query/host-query-key'
import { useWorkspaceExecutionHost } from '../navigation/workspace-execution-host'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import { readRuntimeStatusProbe } from '../transport/connection/runtime-status-probe'
import { callAgentSession } from './mobile-structured-agent-session-rpc'
import type { HostModelCatalogCache } from './use-mobile-host-model-catalog-upgrade'

// The host's account-level lists per agent, which a chat's first frame shows before its own read answers.
const hostModelCatalogQuery = defineHostQuery({
  family: 'agentSession.modelCatalog',
  // savedOnly answers from the host's saved lists without starting the agent's CLI.
  fetch: async (
    client,
    _target,
    { agent }: { agent: string },
    previous: HostModelCatalogSnapshot | null | undefined
  ) =>
    withHostModelCatalogAnswer(
      previous ?? undefined,
      null,
      await callAgentSession<AgentSessionModelCatalogResult>(client, 'agentSession.modelCatalog', {
        agent,
        savedOnly: true
      })
    ) ?? null,
  staleTime: 10 * 60_000,
  gcTime: 30 * 60_000
})

/** One chat agent's lists in this world: preloaded saved-only when the host can answer without its CLI. */
export function useHostModelCatalogCache(args: {
  hostId: string | undefined
  client: RpcClient | null
  agent: string | null
  enabled: boolean
}): HostModelCatalogCache | null {
  const { hostId, client, agent, enabled } = args
  const queryClient = useQueryClient()
  const exec = useWorkspaceExecutionHost() ?? 'local'
  // Older hosts list (start the CLI) when nothing is saved, so only hosts that read saved-only are preloaded.
  // The session's capability probe already answered for this connection; its answer re-renders the chat.
  const preload =
    enabled &&
    !!client &&
    hostReadsSavedModelCatalogsOnly(readRuntimeStatusProbe(client)?.capabilities)
  useHostQuery(
    hostModelCatalogQuery,
    { hostId: hostId ?? '', client },
    { exec },
    { agent: agent ?? '' },
    { enabled: preload && !!hostId && !!agent }
  )
  return useMemo(() => {
    if (!hostId || !agent) {
      return null
    }
    const queryKey = hostQueryKey(hostId, hostModelCatalogQuery.family, { exec }, { agent })
    return {
      seed: (launch) =>
        selectHostModelCatalogSnapshot(
          queryClient.getQueryData<HostModelCatalogSnapshot | null>(queryKey) ?? undefined,
          launch
        ),
      // A new chat's answer is the account's a new chat pins, so the next chat starts from it.
      record: (worktree, catalog) => {
        const held =
          queryClient.getQueryData<HostModelCatalogSnapshot | null>(queryKey) ?? undefined
        const next = withHostModelCatalogAnswer(held, worktree, catalog)
        if (next === held) {
          return
        }
        queryClient.setQueryData<HostModelCatalogSnapshot | null>(queryKey, next ?? null)
        // A preload sent before this list is older; cancelling it keeps the list just set.
        if (
          next?.byWorktree.has(worktree) &&
          queryClient.isFetching({ queryKey, exact: true }) > 0
        ) {
          void queryClient.cancelQueries({ queryKey, exact: true }, { silent: true })
        }
      }
    }
  }, [agent, exec, hostId, queryClient])
}
