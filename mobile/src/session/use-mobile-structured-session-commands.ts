import { useCallback, useEffect, useState } from 'react'
import { z } from 'zod'
import type { AgentSessionSlashCommand } from '../../../src/shared/agent-session-wire'
import type { RpcClient } from '../transport/rpc-client'
import { bindDeferredRpcOperation, defineRpcOperation } from '../transport/rpc-operation'
import { rpcResultVariant } from '../transport/rpc-operation-result-reader'

type Reported = { sessionId: string; commands: readonly AgentSessionSlashCommand[] }

const sessionCommandsSchema = z.looseObject({
  commands: z
    .array(
      z.looseObject({
        name: z.string(),
        kind: z.enum(['command', 'skill']),
        kindUnspecified: z.literal(true).optional(),
        description: z.string().optional(),
        argumentHint: z.string().optional(),
        path: z.string().optional()
      })
    )
    .optional()
})

/** The `/` menu a session reports. A host that predates the read refuses it: a skip, so the menu
 *  keeps the host's own commands. */
const sessionCommandsRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'agent-session.commands-or-skip',
    method: 'agentSession.commands',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('agent-session-commands', sessionCommandsSchema)
  })
)

/**
 * The `/` menu the running session reports: its commands and the skills it loaded.
 *
 * Phones get bounded subscribe frames, which never carry the list, so it is read on its own: once
 * per session and again each time the menu opens, since a skill installed mid-chat lands there. A
 * read asked for while one is out follows it rather than being dropped.
 */
export function useMobileStructuredSessionCommands(args: {
  client: RpcClient | null
  hostId: string | null
  sessionId: string | null
  enabled: boolean
}): { commands: readonly AgentSessionSlashCommand[] | undefined; refresh: () => void } {
  const { client, hostId, sessionId, enabled } = args
  const [reported, setReported] = useState<Reported | null>(null)
  const [readCount, setReadCount] = useState(0)

  useEffect(() => {
    if (!client || !hostId || !sessionId || !enabled) {
      return
    }
    let stale = false
    void sessionCommandsRead
      .requestSingleFlight(client, hostId, { sessionId })
      .then((reply) => {
        const read = sessionCommandsRead.interpret(reply)
        if (!stale && read.accepted && read.value.commands) {
          setReported({ sessionId, commands: read.value.commands })
        }
      })
      .catch(() => undefined)
    return () => {
      stale = true
    }
  }, [client, enabled, hostId, readCount, sessionId])

  const refresh = useCallback(() => setReadCount((count) => count + 1), [])

  return {
    commands: reported?.sessionId === sessionId ? reported.commands : undefined,
    refresh
  }
}
