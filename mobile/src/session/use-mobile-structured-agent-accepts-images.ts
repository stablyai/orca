import { useEffect, useState } from 'react'
import { z } from 'zod'
import {
  decodeAgentSessionAgentsResult,
  structuredAgentAcceptsImages,
  type AgentSessionRegisteredAgent
} from '../../../src/shared/agent-session-registered-agents'
import type { RpcClient } from '../transport/rpc-client'
import { bindDeferredRpcOperation, defineRpcOperation } from '../transport/rpc-operation'
import { rpcResultVariant } from '../transport/rpc-operation-result-reader'

const registeredAgentsRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'agentSession.registered-agents',
    method: 'agentSession.agents',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    // Row by row, as desktop reads it: a row this build cannot read is dropped, not the list.
    read: rpcResultVariant(
      'registered-agents',
      z.unknown().transform(decodeAgentSessionAgentsResult)
    )
  })
)

type RegisteredAgents = readonly AgentSessionRegisteredAgent[]
type RegisteredAgentsCache = {
  read: Promise<RegisteredAgents> | null
  agents: RegisteredAgents | null
}

/** One read per connection, shared by every chat on the client. */
const registeredAgentsByClient = new WeakMap<RpcClient, RegisteredAgentsCache>()

function registeredAgentsCache(client: RpcClient): RegisteredAgentsCache {
  let cache = registeredAgentsByClient.get(client)
  if (!cache) {
    const created: RegisteredAgentsCache = { read: null, agents: null }
    // The next connection may reach an updated host.
    client.onStateChange((state) => {
      if (state !== 'connected') {
        created.read = null
        created.agents = null
      }
    })
    registeredAgentsByClient.set(client, created)
    cache = created
  }
  return cache
}

function readRegisteredAgents(client: RpcClient): Promise<RegisteredAgents> {
  const cache = registeredAgentsCache(client)
  if (cache.read) {
    return cache.read
  }
  const read = registeredAgentsRead.request(client, {}).then((response) => {
    const agents = registeredAgentsRead.interpret(response)
    if (!agents) {
      throw new Error('agentSession.agents returned no list')
    }
    if (cache.read === read) {
      cache.agents = agents
    }
    return agents
  })
  cache.read = read
  // A failed read is forgotten, so the next ask retries.
  read.catch(() => {
    if (cache.read === read) {
      cache.read = null
    }
  })
  return read
}

/** Whether the active structured chat's agent takes images, by the record its host listed, as on
 *  desktop. A host that lists no agents is asked nothing and offers only Claude and Codex. */
export function useMobileStructuredAgentAcceptsImages(args: {
  client: RpcClient | null
  /** The host advertises `agentSession.agents`. */
  hostListsAgents: boolean
  agent: string | null
}): boolean {
  const { agent, client, hostListsAgents } = args
  const [listed, setListed] = useState<{ client: RpcClient; agents: RegisteredAgents } | null>(null)
  useEffect(() => {
    if (!client || !hostListsAgents) {
      return
    }
    let current = true
    readRegisteredAgents(client)
      .then((agents) => {
        if (current) {
          setListed({ client, agents })
        }
      })
      // An unread list leaves the built-in answer; opening another chat asks again.
      .catch(() => {})
    return () => {
      current = false
    }
  }, [agent, client, hostListsAgents])
  if (!agent) {
    return false
  }
  const agents =
    client && hostListsAgents
      ? (registeredAgentsByClient.get(client)?.agents ??
        (listed?.client === client ? listed.agents : undefined))
      : undefined
  return structuredAgentAcceptsImages(
    agents?.find((row) => row.agent === agent),
    agent
  )
}
