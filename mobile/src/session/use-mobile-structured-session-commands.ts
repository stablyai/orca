import { startAgentSessionCommandMenuQuery } from '../../../src/shared/agent-session-command-menu-query'
import { useCallback, useEffect, useRef, useState } from 'react'
import { z } from 'zod'
import type { AgentSessionSlashCommand } from '../../../src/shared/agent-session-wire'
import type { RpcClient } from '../transport/rpc-client'
import { bindDeferredRpcOperation, defineRpcOperation } from '../transport/rpc-operation'
import { rpcResultVariant } from '../transport/rpc-operation-result-reader'

type Reported = {
  client: RpcClient
  hostId: string
  sessionId: string
  commands: readonly AgentSessionSlashCommand[]
}

const sessionCommandsSchema = z.looseObject({
  commandsPending: z.boolean().optional(),
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

// Older hosts refuse this read; retain their published commands on skip.
const sessionCommandsRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'agent-session.commands-or-skip',
    method: 'agentSession.commands',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('agent-session-commands', sessionCommandsSchema)
  })
)

// Bounded phone frames omit commands; reread on menu open for newly installed skills and follow any in-flight read.
export function useMobileStructuredSessionCommands(args: {
  client: RpcClient | null
  hostId: string | null
  sessionId: string | null
  enabled: boolean
  commandsOnRequest?: boolean
}): {
  commands: readonly AgentSessionSlashCommand[] | undefined
  refresh: () => void
  setMenuOpen: (open: boolean) => void
  invalidate: () => void
} {
  const { client, hostId, sessionId, enabled, commandsOnRequest = false } = args
  const [menuOpen, setMenuOpen] = useState(false)
  const query = useRef<ReturnType<typeof startAgentSessionCommandMenuQuery> | null>(null)
  const [reported, setReported] = useState<Reported | null>(null)
  const [readCount, setReadCount] = useState(0)

  useEffect(() => {
    if (!client || !hostId || !sessionId || !enabled || commandsOnRequest) {
      return
    }
    let stale = false
    void sessionCommandsRead
      .requestSingleFlight(client, hostId, { sessionId })
      .then((reply) => {
        const read = sessionCommandsRead.interpret(reply)
        if (!stale && read.accepted && read.value.commands) {
          setReported({ client, hostId, sessionId, commands: read.value.commands })
        }
      })
      .catch(() => undefined)
    return () => {
      stale = true
    }
  }, [client, commandsOnRequest, enabled, hostId, readCount, sessionId])

  useEffect(() => {
    if (!commandsOnRequest || !menuOpen || !enabled || !client || !hostId || !sessionId) {
      return
    }
    const owned = startAgentSessionCommandMenuQuery(
      async () => {
        const reply = await sessionCommandsRead.request(
          client,
          { sessionId },
          {
            timeoutMs: 30_000,
            failWhenDisconnected: true,
            budgetSpansConnect: true
          }
        )
        const result = sessionCommandsRead.interpret(reply)
        if (!result.accepted) {
          throw new Error('Commands unavailable')
        }
        return result.value
      },
      (result) => {
        if (result.commands !== undefined) {
          setReported({ client, hostId, sessionId, commands: result.commands })
        } else if (!result.commandsPending) {
          setReported((previous) =>
            previous?.client === client &&
            previous.hostId === hostId &&
            previous.sessionId === sessionId
              ? null
              : previous
          )
        }
      }
    )
    query.current = owned
    return () => {
      query.current = null
      owned.dispose()
    }
  }, [client, commandsOnRequest, enabled, hostId, menuOpen, sessionId])
  const invalidate = useCallback(() => query.current?.invalidate(), [])
  const refresh = useCallback(() => {
    if (!commandsOnRequest) {
      setReadCount((count) => count + 1)
    }
  }, [commandsOnRequest])

  return {
    commands:
      reported?.client === client && reported.hostId === hostId && reported.sessionId === sessionId
        ? reported.commands
        : undefined,
    refresh,
    setMenuOpen,
    invalidate
  }
}
