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

/** Whether the active structured chat's agent takes images, by the record its host listed, as on
 *  desktop. A host that lists no agents is asked nothing and offers only Claude and Codex. */
export function useMobileStructuredAgentAcceptsImages(args: {
  client: RpcClient | null
  /** The host advertises `agentSession.agents`. */
  hostListsAgents: boolean
  agent: string | null
}): boolean {
  const { agent, client, hostListsAgents } = args
  const [listed, setListed] = useState<{
    client: RpcClient
    agents: readonly AgentSessionRegisteredAgent[]
  } | null>(null)
  useEffect(() => {
    if (!client || !hostListsAgents) {
      return
    }
    let current = true
    registeredAgentsRead
      .request(client, {})
      .then((response) => {
        const agents = registeredAgentsRead.interpret(response)
        if (current && agents) {
          setListed({ client, agents })
        }
      })
      // An unread list leaves the built-in answer; the next connection asks again.
      .catch(() => {})
    return () => {
      current = false
    }
  }, [client, hostListsAgents])
  if (!agent) {
    return false
  }
  const agents = hostListsAgents && listed?.client === client ? listed.agents : undefined
  return structuredAgentAcceptsImages(
    agents?.find((row) => row.agent === agent),
    agent
  )
}
