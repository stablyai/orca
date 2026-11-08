import { startAgentSessionCommandMenuQuery } from '../../../src/shared/agent-session/agent-session-command-menu-query'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import * as z from 'zod'
import type { AgentSessionSlashCommand } from '../../../src/shared/agent-session/agent-session-wire'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import { bindDeferredRpcOperation, defineRpcOperation } from '../transport/rpc/rpc-operation'
import { rpcResultVariant } from '../transport/rpc/rpc-operation-result-reader'
import { defineHostQuery, useHostQuery } from '../query/host-query'
import { hostQueryKey } from '../query/host-query-key'
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
  const queryClient = useQueryClient()
  const { data: published } = useHostQuery(
    sessionCommandsQuery,
    { hostId: hostId ?? '', client },
    { exec },
    { sessionId: sessionId ?? '' },
    { enabled: reads }
  )
  const commandsKey = useMemo(
    () =>
      hostQueryKey(
        hostId ?? '',
        sessionCommandsQuery.family,
        { exec },
        { sessionId: sessionId ?? '' }
      ),
    [exec, hostId, sessionId]
  )

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
    // Read state from the client: reading it off the result would re-render the chat on every fetch.
    // A disabled query is skipped, so a read queued behind one in flight never runs against a gone host.
    const filters = { queryKey: commandsKey, exact: true }
    const state = queryClient.getQueryState(commandsKey)
    // Without data TanStack joins the read in flight, which may predate a newly installed skill: read once more after it.
    void (state?.data === undefined && state?.fetchStatus === 'fetching'
      ? queryClient
          .refetchQueries(filters, { cancelRefetch: false })
          .then(() => queryClient.refetchQueries(filters, { cancelRefetch: false }))
      : queryClient.refetchQueries(filters))
  }, [queryClient, commandsKey])

  return {
    // A menu-read answer outlives the capability flag, which resets while a reconnect re-probes the host.
    commands:
      reported?.client === client && reported.hostId === hostId && reported.sessionId === sessionId
        ? reported.commands
        : !commandsOnRequest && hostId && sessionId
          ? (published ?? undefined)
          : undefined,
    refresh,
    setMenuOpen,
    invalidate
  }
}
