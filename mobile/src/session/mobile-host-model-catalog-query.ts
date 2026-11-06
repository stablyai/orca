import type { QueryClient } from '@tanstack/react-query'
import type { AgentSessionModelCatalogResult } from '../../../src/shared/agent-session/agent-session-wire'
import {
  selectHostModelCatalogSnapshot,
  withHostModelCatalogAnswer,
  type HostModelCatalogLaunch,
  type HostModelCatalogSnapshot
} from '../../../src/shared/agent-session/options/host-model-catalog-snapshot-rules'
import type { ExecutionHostId } from '../../../src/shared/execution-host'
import { defineHostQuery } from '../query/host-query'
import { hostQueryKey } from '../query/host-query-key'
import { callAgentSession } from './mobile-structured-agent-session-rpc'

// The host's account-level lists per agent, which a chat's first frame shows before its own read answers.
export const hostModelCatalogQuery = defineHostQuery({
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

type HostModelCatalogScope = { hostId: string; exec: ExecutionHostId; agent: string }

export const hostModelCatalogKey = ({ hostId, exec, agent }: HostModelCatalogScope) =>
  hostQueryKey(hostId, hostModelCatalogQuery.family, { exec }, { agent })

/** The last host list that fits this chat, or undefined when none does. */
export function readHostModelCatalogSeed(
  queryClient: QueryClient,
  scope: HostModelCatalogScope,
  launch: HostModelCatalogLaunch
): AgentSessionModelCatalogResult | undefined {
  return selectHostModelCatalogSnapshot(
    queryClient.getQueryData<HostModelCatalogSnapshot | null>(hostModelCatalogKey(scope)) ??
      undefined,
    launch
  )
}
