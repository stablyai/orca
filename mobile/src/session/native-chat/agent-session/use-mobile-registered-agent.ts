import { useCallback, useEffect, useState } from 'react'
import {
  AGENT_SESSION_AGENTS_METHOD,
  decodeAgentSessionAgentsResult,
  type AgentSessionRegisteredAgent
} from '../../../../../src/shared/agent-session/agent-session-registered-agents'
import type { RpcClient } from '../../../transport/rpc/rpc-client-contract'

const AGENTS_READ_RETRIES_MS = [2_000, 8_000, 30_000]

/** One stretch of discovery: a client, its generation, and one supported, unlearned spell. Its
 *  reads, failures and retry timer die with it, so a new stretch starts with every retry. */
type Discovery = {
  client: RpcClient | null
  generation: number | undefined
  wanted: boolean
  id: number
  count: number
  failures: number
}

/** The host's agents, read once per connection while `offered` (the host serves what the caller needs them for). */
export function useMobileRegisteredAgent(
  client: RpcClient | null,
  offered: boolean,
  agent: string | null
): AgentSessionRegisteredAgent | undefined {
  const [agents, setAgents] = useState<{
    client: RpcClient
    generation: number | undefined
    rows: readonly AgentSessionRegisteredAgent[]
  } | null>(null)
  const generation = client?.getGeneration?.()
  const learned = agents?.client === client && agents?.generation === generation
  const wanted = !!client && offered && !learned
  const [stored, setDiscovery] = useState<Discovery>({
    client,
    generation,
    wanted,
    id: 0,
    count: 0,
    failures: 0
  })
  let discovery = stored
  if (stored.client !== client || stored.generation !== generation || stored.wanted !== wanted) {
    // A new stretch, false ones included, so resuming never reuses an earlier budget.
    discovery = { client, generation, wanted, id: stored.id + 1, count: 0, failures: 0 }
    setDiscovery(discovery)
  }
  const { id } = discovery
  // Updates from an earlier stretch's read, timer or listener change nothing.
  const update = useCallback(
    (next: (current: Discovery) => Pick<Discovery, 'count' | 'failures'>) =>
      setDiscovery((current) => (current.id === id ? { ...current, ...next(current) } : current)),
    [id]
  )
  useEffect(() => {
    if (!client || !wanted) {
      return
    }
    let cancelled = false
    void client
      .sendRequest(AGENT_SESSION_AGENTS_METHOD, {})
      .then((response) => (response.ok ? decodeAgentSessionAgentsResult(response.result) : null))
      .catch(() => null)
      .then((rows) => {
        if (cancelled) {
          return
        }
        if (rows) {
          setAgents({ client, generation, rows })
        } else {
          update((current) => ({ count: current.count, failures: current.failures + 1 }))
        }
      })
    return () => {
      cancelled = true
    }
  }, [client, generation, wanted, update, discovery.count])
  // The action stays disabled while unread: a few spaced retries, then the next reconnect.
  const retryMs = wanted ? AGENTS_READ_RETRIES_MS[discovery.failures - 1] : undefined
  useEffect(() => {
    if (retryMs === undefined) {
      return
    }
    const timer = setTimeout(
      () => update((current) => ({ count: current.count + 1, failures: current.failures })),
      retryMs
    )
    return () => clearTimeout(timer)
    // One timer per failure of this stretch; a retry's own read must not arm another.
  }, [update, retryMs, discovery.failures])
  useEffect(() => {
    if (!client || !wanted) {
      return
    }
    return client.onStateChange((state) => {
      if (state === 'connected') {
        update((current) => ({ count: current.count + 1, failures: 0 }))
      }
    })
  }, [client, wanted, update])
  return learned ? agents.rows.find((row) => row.agent === agent) : undefined
}
