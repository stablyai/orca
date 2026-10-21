import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import type { CommandHandler } from '../dispatch'
import { createWorkInboxMcpServer } from '../work-inbox-mcp-tools'
import { resolveOrchestrationTerminalHandle } from './orchestration/terminal-identity'
import { ORCHESTRATION_ASK_CLIENT_GRACE_MS } from '../../shared/orchestration-ask-timeout'
import type { WorkInboxAskResult, WorkInboxMutationResult } from '../../shared/work-inbox'
import { injectedSessionAddress } from '../../shared/agent-session-caller-env'
import { RuntimeClientError } from '../runtime-client'

export const WORK_INBOX_MCP_HANDLERS: Record<string, CommandHandler> = {
  'inbox mcp': async ({ flags, client, cwd }) => {
    const from =
      (await resolveOrchestrationTerminalHandle(flags, cwd, client, 'from')) ??
      injectedSessionAddress()
    const server = createWorkInboxMcpServer(
      async (params) => {
        const response = await client.call<WorkInboxAskResult>(
          'workInbox.ask',
          { ...params, from },
          {
            timeoutMs: params.timeoutMs + ORCHESTRATION_ASK_CLIENT_GRACE_MS
          }
        )
        return response.result
      },
      async (id) => {
        const response = await client.call<WorkInboxMutationResult>('workInbox.ack', { id, from })
        if (response.result.status !== 'ok') {
          throw new RuntimeClientError(
            'work_inbox_ack_rejected',
            'The question has no received answer to acknowledge.'
          )
        }
        return { id: response.result.item.id, status: response.result.item.status }
      }
    )
    await server.connect(new StdioServerTransport())
  }
}
