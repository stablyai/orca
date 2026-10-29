import { useEffect, useState } from 'react'
import { z } from 'zod'
import {
  getAgentSessionOptionCatalog,
  type CatalogModel
} from '../../../src/shared/agent-session-option-catalog'
import {
  catalogModelsFromModelDiscovery,
  mergeDiscoveredCatalogModels
} from '../../../src/shared/native-chat-discovered-catalog-models'
import { defineRpcOperation, runRpcOperation } from '../transport/rpc-operation'

const discoveredModel = z.object({
  id: z.string().min(1),
  label: z.string(),
  description: z.string().optional(),
  thinkingLevels: z.array(z.object({ id: z.string(), label: z.string() })).optional(),
  supportsFastMode: z.boolean().optional(),
  isDefault: z.boolean().optional(),
  contextWindowTokens: z.number().optional()
})

const discoveryResult = z.union([
  z.object({
    success: z.literal(true),
    catalogOrigin: z.enum(['probe', 'spec']).optional(),
    models: z.array(discoveredModel)
  }),
  z.object({ success: z.literal(false) })
])

const discoverModels = defineRpcOperation({
  name: 'native-chat.configured-models',
  method: 'git.discoverCommitMessageModels',
  acceptance: 'require-result-or-throw',
  barrier: 'on-settle',
  read: (raw: unknown) => {
    const parsed = discoveryResult.safeParse(raw)
    return {
      compatible: true as const,
      variant: 'configured-models' as const,
      value: parsed.success ? parsed.data : null,
      salvage: { droppedPaths: [], droppedCount: 0 }
    }
  }
})

/** The runtime resolves the workspace's execution host, including SSH and folder workspaces. */
export function useMobileNativeChatModelDiscovery(args: {
  client: Parameters<typeof runRpcOperation>[0] | null
  agent: string | null
  hostId: string
  worktreeId: string
  enabled: boolean
}): CatalogModel[] | null {
  const { client, agent, hostId, worktreeId, enabled } = args
  const scope = JSON.stringify([hostId, worktreeId, agent])
  const [result, setResult] = useState<{
    client: typeof client
    scope: string
    models: CatalogModel[]
  } | null>(null)
  useEffect(() => {
    const catalog = agent ? getAgentSessionOptionCatalog(agent) : null
    if (!enabled || !client || !worktreeId || !agent || !catalog) {
      return
    }
    let cancelled = false
    void runRpcOperation(client, discoverModels, { worktree: `id:${worktreeId}`, agentId: agent })
      .then((discovery) => {
        const models = discovery ? catalogModelsFromModelDiscovery(agent, discovery) : null
        if (!cancelled && models !== null) {
          setResult({ client, scope, models: mergeDiscoveredCatalogModels(agent, catalog, models) })
        }
      })
      .catch(() => {
        // Discovery failure leaves the authoritative hook model available.
      })
    return () => {
      cancelled = true
    }
  }, [agent, client, enabled, scope, worktreeId])
  return enabled && result?.client === client && result?.scope === scope ? result.models : null
}
