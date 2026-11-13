import type { CommandHandler } from '../dispatch/dispatch'
import {
  getOptionalPositiveIntegerFlag,
  getOptionalStringFlag,
  getRequiredStringFlag
} from '../arguments/flags'
import { printResult } from '../output/command-result-output'
import { RuntimeClientError } from '../runtime/types'
import type { RuntimeClient } from '../runtime/client'
import { getOptionalWorktreeSelector } from '../workspace-selection/workspace-selector'
import {
  annotateOmittedHostScope,
  formatListingHostScope,
  type WithAnnotatedHostScope
} from '../hosts/omitted-host-scope-selectors'
import {
  AGENT_READ_MAX_LIMIT,
  type AgentConversationRow,
  type AgentListResult,
  type AgentReadResult,
  type AgentReadTool,
  type AgentShowResult
} from '../../shared/agent-conversations/agent-conversation-contracts'
import { AGENT_STATUS_STATES } from '../../shared/agent-status/contracts/agent-status-types'
import type { RuntimeWorktreeRecord } from '../../shared/runtime-worktree-contracts'
import { ORCA_SESSION_ADDRESS_PREFIX } from '../../shared/orca-session-address-prefix'
import {
  AGENT_SESSION_UNATTACHED_REFUSAL_CODE,
  isUnattachedAgentSessionReadRefusal
} from '../../shared/agent-session/failures/structured-agent-session-read-refusal'

export const AGENT_CONVERSATION_HANDLERS: Record<string, CommandHandler> = {
  'agent list': async ({ flags, client, cwd, json }) => {
    const state = getOptionalStringFlag(flags, 'state')
    if (state !== undefined && !AGENT_STATUS_STATES.some((known) => known === state)) {
      throw new RuntimeClientError(
        'invalid_argument',
        `--state must be one of: ${AGENT_STATUS_STATES.join(', ')}.`
      )
    }
    const selector = await getOptionalWorktreeSelector(flags, 'worktree', cwd, client)
    const worktreeId = selector
      ? (
          await client.call<{ worktree: RuntimeWorktreeRecord }>('worktree.show', {
            worktree: selector,
            matchFolderWorkspaces: true
          })
        ).result.worktree.id
      : undefined
    const result = await callAgentMethod<WithAnnotatedHostScope<AgentListResult>>(
      client,
      'agent.list',
      { ...(worktreeId ? { worktreeId } : {}), ...(state ? { state } : {}) }
    )
    await annotateOmittedHostScope(result.result)
    printResult(result, json, formatAgentList)
  },
  'agent show': async ({ flags, client, json }) => {
    const result = await callAgentMethod<AgentShowResult>(client, 'agent.show', {
      id: getRequiredStringFlag(flags, 'id')
    })
    printResult(result, json, formatAgentShow)
  },
  'agent read': async ({ flags, client, json }) => {
    const limit = getOptionalPositiveIntegerFlag(flags, 'limit')
    if (limit !== undefined && limit > AGENT_READ_MAX_LIMIT) {
      throw new RuntimeClientError(
        'invalid_argument',
        `--limit can be at most ${AGENT_READ_MAX_LIMIT}.`
      )
    }
    const cursor = getOptionalStringFlag(flags, 'cursor')
    const result = await callAgentMethod<AgentReadResult>(client, 'agent.read', {
      id: getRequiredStringFlag(flags, 'id'),
      ...(limit !== undefined ? { limit } : {}),
      ...(cursor ? { cursor } : {})
    })
    printResult(result, json, formatAgentRead)
  }
}

async function callAgentMethod<TResult>(client: RuntimeClient, method: string, params: unknown) {
  return client.call<TResult>(method, params).catch((error: unknown) => {
    if (!(error instanceof RuntimeClientError)) {
      throw error
    }
    if (error.code === 'method_not_found') {
      throw new RuntimeClientError(
        'incompatible_runtime',
        'This Orca host has no agent commands yet. Update Orca on that host to use agent commands.'
      )
    }
    // Chat reads answer with bare wire codes; say what they mean.
    if ([error.code, error.message].includes('structured_agent_session_unsupported')) {
      throw new RuntimeClientError(
        'incompatible_runtime',
        "This Orca host can't read that chat from the CLI. Update Orca on that host, or check that it has chats turned on."
      )
    }
    if (isUnattachedAgentSessionReadRefusal(error)) {
      throw new RuntimeClientError(
        AGENT_SESSION_UNATTACHED_REFUSAL_CODE,
        'That chat is opening or closing right now. Try again in a moment.'
      )
    }
    throw error
  })
}

function address(row: { orcaSessionId: string | null }): string {
  return row.orcaSessionId
    ? `${ORCA_SESSION_ADDRESS_PREFIX}${row.orcaSessionId}`
    : 'none yet (Orca names a terminal agent after its first report)'
}

function formatAgentRow(row: AgentConversationRow): string {
  return [
    `${row.repo ? `${row.repo} › ` : ''}${row.workspace} · ${row.agent ?? 'agent'} ${row.kind} · ${row.state}`,
    `  id: ${address(row)}`,
    ...(row.title ? [`  title: ${row.title}`] : []),
    ...(row.lastAssistantMessage
      ? [`  last reply: ${row.lastAssistantMessage.replace(/\s+/g, ' ').slice(0, 200)}`]
      : [])
  ].join('\n')
}

function formatAgentList(result: WithAnnotatedHostScope<AgentListResult>): string {
  const scope = result.hostScope
  const lines = [
    result.agents.length === 0 ? 'No open agents.' : result.agents.map(formatAgentRow).join('\n\n')
  ]
  // Agents on hosts this one does not list are reached by running there or with --environment.
  if (!scope || scope.omittedHostIds.length > 0) {
    lines.push('', formatListingHostScope(scope))
  }
  return lines.join('\n')
}

function formatAgentShow(result: AgentShowResult): string {
  const id = `${ORCA_SESSION_ADDRESS_PREFIX}${result.orcaSessionId}`
  if (result.places.length === 0) {
    return `Agent ${id} (${result.kind}) isn't open in any workspace right now.`
  }
  return result.places.map(formatAgentRow).join('\n\n')
}

function formatTool(tool: AgentReadTool): string {
  return `[tool ${tool.name}${tool.state ? `: ${tool.state}` : ''}]`
}

function formatAgentRead(result: AgentReadResult): string {
  const lines = result.entries.map((entry) => {
    if (entry.kind === 'message') {
      return [
        ...(entry.text ? [`${entry.role}: ${entry.text}`] : []),
        ...(entry.tools ?? []).map((tool) => formatTool(tool))
      ].join('\n')
    }
    if (entry.kind === 'error') {
      return `[error] ${entry.text}`
    }
    if (entry.kind === 'tool') {
      return formatTool(entry)
    }
    return `[${entry.kind}${entry.pending ? ', waiting for an answer' : ''}] ${entry.text}`
  })
  if (lines.length === 0) {
    lines.push('Nothing new.')
  }
  if (result.cursor) {
    lines.push('', `More later: --cursor ${result.cursor}`)
  }
  return lines.join('\n')
}
