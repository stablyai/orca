import { useEffect, useMemo, useState } from 'react'
import * as z from 'zod'
import {
  AGENT_SESSION_AGENTS_METHOD,
  decodeAgentSessionAgentsResult
} from '../../../../src/shared/agent-session/agent-session-registered-agents'
import { isTuiAgent } from '../../../../src/shared/agent-launch/catalog/tui-agent-config'
import type { TuiAgent } from '../../../../src/shared/agent-launch/catalog/tui-agent'
import { isLocalExecutionHost } from '../../../../src/shared/execution-host'
import { useHostQuery } from '../../query/host-query'
import {
  HOST_LIST_TARGET,
  hostWorktreeCatalogQuery,
  NO_HOST_LIST_INPUT
} from '../../host-screen/catalog/host-list-queries'
import { defineRpcOperation, runRpcOperation } from '../../transport/rpc/rpc-operation'
import { rpcResultVariant } from '../../transport/rpc/rpc-operation-result-reader'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'

export type ChatForkWorkspaceRow = { worktreeId: string; name: string; detail: string }

const registeredAgentsSchema = z.unknown().transform((value, ctx) => {
  const agents = decodeAgentSessionAgentsResult(value)
  if (!agents) {
    ctx.addIssue({ code: 'custom' })
    return z.NEVER
  }
  return agents
})

const registeredAgentsRead = defineRpcOperation({
  name: 'agentSession.chat-fork-agents',
  method: AGENT_SESSION_AGENTS_METHOD,
  acceptance: 'require-result-or-throw-message',
  barrier: 'on-settle',
  read: rpcResultVariant('chat-fork-agents', registeredAgentsSchema)
})

const AGENTS_READ_TIMEOUT_MS = 15_000
const NO_ROWS: readonly ChatForkWorkspaceRow[] = []

/** The chosen host's workspaces a fork can open in: its own, unarchived, other than the source. */
export function useChatForkWorkspaceRows(
  client: RpcClient | null,
  hostId: string,
  excludeWorktreeId: string | null
): readonly ChatForkWorkspaceRow[] {
  const { data } = useHostQuery(
    hostWorktreeCatalogQuery,
    { hostId, client },
    HOST_LIST_TARGET,
    NO_HOST_LIST_INPUT
  )
  return useMemo(
    () =>
      data
        ? data.worktrees
            .filter(
              (row) =>
                row.worktreeId !== excludeWorktreeId &&
                row.isArchived !== true &&
                (!row.hostId || isLocalExecutionHost(row.hostId))
            )
            .map((row) => ({
              worktreeId: row.worktreeId,
              name: row.displayName?.trim() || row.branch || row.worktreeId,
              // The project and branch tell same-name workspaces apart.
              detail: [row.repo, row.branch].filter(Boolean).join(' · ')
            }))
        : NO_ROWS,
    [data, excludeWorktreeId]
  )
}

/** The agents the chosen host can start as a chat; null while unread, empty when unreadable. */
export function useChatForkTargetAgents(client: RpcClient | null): readonly TuiAgent[] | null {
  const [read, setRead] = useState<{ client: RpcClient; agents: readonly TuiAgent[] } | null>(null)
  useEffect(() => {
    if (!client) {
      return
    }
    let live = true
    runRpcOperation(client, registeredAgentsRead, {}, { timeoutMs: AGENTS_READ_TIMEOUT_MS })
      .then(
        (rows) => rows.map((row) => row.agent).filter(isTuiAgent),
        () => []
      )
      .then((agents) => {
        if (live) {
          setRead({ client, agents })
        }
      })
    return () => {
      live = false
    }
  }, [client])
  return client && read?.client === client ? read.agents : null
}
