import { useEffect, useState } from 'react'
import { z } from 'zod'
import type { CatalogModel } from '../../../src/shared/agent-session-option-catalog'
import { defineRpcOperation, runRpcOperation } from '../transport/rpc-operation'

const discoveryResult = z.object({
  success: z.literal(true),
  catalogOrigin: z.literal('probe'),
  models: z.array(
    z.object({ id: z.string().min(1), label: z.string(), description: z.string().optional() })
  )
})

const discoverOmpModels = defineRpcOperation({
  name: 'omp.configured-models',
  method: 'git.discoverCommitMessageModels',
  acceptance: 'require-result-or-throw',
  barrier: 'on-settle',
  read: (raw: unknown) => {
    const parsed = discoveryResult.safeParse(raw)
    return {
      compatible: true as const,
      variant: 'configured-models' as const,
      value: parsed.success ? parsed.data.models.map((model) => ({ ...model, options: [] })) : null,
      salvage: { droppedPaths: [], droppedCount: 0 }
    }
  }
})

/** The runtime resolves the workspace's execution host, including SSH and folder workspaces. */
export function useMobileOmpModelDiscovery(args: {
  client: Parameters<typeof runRpcOperation>[0] | null
  hostId: string
  worktreeId: string
  enabled: boolean
}): CatalogModel[] | null {
  const { client, hostId, worktreeId, enabled } = args
  const scope = JSON.stringify([hostId, worktreeId])
  const [result, setResult] = useState<{
    client: typeof client
    scope: string
    models: CatalogModel[]
  } | null>(null)
  useEffect(() => {
    if (!enabled || !client || !worktreeId) {
      return
    }
    let cancelled = false
    void runRpcOperation(client, discoverOmpModels, {
      worktree: `id:${worktreeId}`,
      agentId: 'omp'
    })
      .then((models) => {
        // Older hosts may return static fallback models; they are not configured OMP choices.
        if (!cancelled && models !== null) {
          setResult({
            client,
            scope,
            models
          })
        }
      })
      .catch(() => {
        // Discovery failure leaves the authoritative hook model available.
      })
    return () => {
      cancelled = true
    }
  }, [client, enabled, scope, worktreeId])
  return enabled && result?.client === client && result?.scope === scope ? result.models : null
}
