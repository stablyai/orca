import type { AgentSessionAccountHome } from '../../../shared/agent-session-record'
import type {
  AgentModelCatalogService,
  AgentModelCatalogServiceDeps
} from './agent-model-catalog-service-contract'
import { agentModelCatalogFingerprint } from './agent-model-catalog-fingerprint'

export async function newChatCatalogKey(
  deps: Pick<AgentModelCatalogServiceDeps, 'resolveAccountHome'>,
  agent: string,
  folder?: string
): Promise<{ fingerprint: string; accountHome: AgentSessionAccountHome } | null> {
  let accountHome: AgentSessionAccountHome
  try {
    accountHome = await deps.resolveAccountHome(agent)
  } catch {
    return null
  }
  return {
    fingerprint: agentModelCatalogFingerprint({ agent, accountHome, wslDistro: null, folder }),
    accountHome
  }
}

async function runBounded<T>(
  items: readonly T[],
  limit: number,
  stopped: AbortSignal,
  run: (item: T) => Promise<unknown>
): Promise<void> {
  const queue = [...items]
  const worker = async (): Promise<void> => {
    for (let item = queue.shift(); item !== undefined && !stopped.aborted; item = queue.shift()) {
      await run(item).catch(() => {})
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, queue.length) }, worker))
}

export async function prewarmAgentModelCatalog(
  deps: AgentModelCatalogServiceDeps,
  signal: AbortSignal,
  read: AgentModelCatalogService['read']
): Promise<void> {
  if (signal.aborted) {
    return
  }
  const probes = deps.probes ?? {}
  // Unused agents wait for their first chat instead of spawning speculative probes.
  const used = Object.keys(probes).filter(
    (agent) =>
      !deps.listsInChatFolder?.has(agent) &&
      (deps.store.hasEntryForAgent(agent) || deps.hasChatRecords?.(agent) === true)
  )
  await runBounded(used, 2, signal, async (agent) => {
    await read({ agent, waitForListing: true })
  })
}
