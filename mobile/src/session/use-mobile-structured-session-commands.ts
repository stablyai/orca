import { startAgentSessionCommandMenuQuery } from '../../../src/shared/agent-session/agent-session-command-menu-query'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import * as z from 'zod'
import type { AgentSessionSlashCommand } from '../../../src/shared/agent-session/agent-session-wire'
import type { RpcClient } from '../transport/rpc-client'
import { bindDeferredRpcOperation, defineRpcOperation } from '../transport/rpc-operation'
import { rpcResultVariant } from '../transport/rpc-operation-result-reader'
import { defineHostQuery, useHostQuery } from '../query/host-query'
import { useWorkspaceExecutionHost } from '../navigation/workspace-execution-host'

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

// A chat's last reported commands, so a reopened composer's `/` menu has them at once.
const sessionCommandsQuery = defineHostQuery({
  family: 'agentSession.commands',
  fetch: async (
    client,
    _target,
    { sessionId }: { sessionId: string },
    previous: readonly AgentSessionSlashCommand[] | null | undefined
  ) => {
    const read = sessionCommandsRead.interpret(
      await sessionCommandsRead.request(client, { sessionId })
    )
    return read.accepted && read.value.commands ? read.value.commands : (previous ?? null)
  },
  staleTime: 60_000
})

// Bounded phone frames omit commands; reread on menu open for newly installed skills.
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
  const exec = useWorkspaceExecutionHost() ?? 'local'
  const reads = !!hostId && !!sessionId && enabled && !commandsOnRequest
  const commandsQuery = useHostQuery(
    sessionCommandsQuery,
    { hostId: hostId ?? '', client },
    { exec },
    { sessionId: sessionId ?? '' },
    { enabled: reads }
  )
  const { data: published } = commandsQuery
  const commandsQueryRef = useRef(commandsQuery)
  useLayoutEffect(() => {
    commandsQueryRef.current = commandsQuery
  }, [commandsQuery])

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
    if (!reads) {
      return
    }
    const { data, isFetching, refetch } = commandsQueryRef.current
    // Without data TanStack joins the read in flight, which may predate a newly installed skill: read once more after it.
    void (data === undefined && isFetching
      ? refetch().then(() => refetch({ cancelRefetch: false }))
      : refetch())
  }, [reads])

  return {
    commands: commandsOnRequest
      ? reported?.client === client &&
        reported.hostId === hostId &&
        reported.sessionId === sessionId
        ? reported.commands
        : undefined
      : hostId && sessionId
        ? (published ?? undefined)
        : undefined,
    refresh,
    setMenuOpen,
    invalidate
  }
}
