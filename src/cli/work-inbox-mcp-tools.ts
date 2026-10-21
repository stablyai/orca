import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { WorkInboxAskResult } from '../shared/work-inbox'
import { WORK_INBOX_ROUTING_INSTRUCTIONS } from '../shared/work-inbox-routing-instructions'

export type WorkInboxAsk = (params: {
  question?: string
  resume?: string
  options?: string
  timeoutMs: number
  requestId?: string
}) => Promise<WorkInboxAskResult>
export type WorkInboxAcknowledge = (id: string) => Promise<{ id: string; status: string }>
const WAIT_BUDGET = z.number().int().min(1000).max(50000).default(30000)
const QUESTION_ID = z.string().min(1).max(256)

export function createWorkInboxMcpServer(
  ask: WorkInboxAsk,
  acknowledge: WorkInboxAcknowledge
): McpServer {
  const server = new McpServer(
    { name: 'orca-work-inbox', version: '1.0.0' },
    { instructions: WORK_INBOX_ROUTING_INSTRUCTIONS }
  )
  async function questionResult(params: Parameters<WorkInboxAsk>[0]) {
    try {
      const outcome = await ask(params)
      const result = {
        ...outcome,
        requestId: params.requestId,
        nextAction:
          outcome.answer !== null
            ? 'Call acknowledge_answer with this id, then continue using the answer.'
            : outcome.cancelled
              ? 'The user closed the question without providing an answer. This is not approval; do not choose a suggested option.'
              : 'Call wait_for_answer with this id. Do not create another question.'
      }
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result) }],
        structuredContent: result
      }
    } catch (error) {
      const code =
        error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
          ? error.code
          : 'unconfirmed'
      const result = {
        status: 'error',
        code,
        requestId: params.requestId,
        nextAction:
          'Preserve the request_id. After an uncertain send retry the identical ask_user arguments, or resume a known question id. Never create a replacement question.'
      }
      return {
        isError: true,
        content: [{ type: 'text' as const, text: JSON.stringify(result) }],
        structuredContent: result
      }
    }
  }
  server.registerTool(
    'ask_user',
    {
      description: `${WORK_INBOX_ROUTING_INSTRUCTIONS} Supply a fresh UUID request_id for each immutable question. Choosing an option only edits a draft; the human explicitly sends the answer.`,
      inputSchema: {
        request_id: z.string().uuid(),
        question: z.string().trim().min(1).max(8000),
        options: z
          .array(
            z
              .string()
              .trim()
              .min(1)
              .max(256)
              .refine((value) => !value.includes(','), 'Options cannot contain commas')
          )
          .max(16)
          .optional(),
        timeout_ms: WAIT_BUDGET
      }
    },
    async ({ request_id, question, options, timeout_ms }) =>
      questionResult({
        question,
        options: options?.join(','),
        timeoutMs: timeout_ms,
        requestId: request_id
      })
  )
  server.registerTool(
    'wait_for_answer',
    {
      description:
        'Wait for the original question after a timeout, interruption or reconnect. Pass its id as question_id; never create a replacement. After receiving an answer call acknowledge_answer, then continue.',
      inputSchema: { question_id: QUESTION_ID, timeout_ms: WAIT_BUDGET }
    },
    async ({ question_id, timeout_ms }) =>
      questionResult({ resume: question_id, timeoutMs: timeout_ms })
  )
  server.registerTool(
    'acknowledge_answer',
    {
      description:
        'Confirm that you received the human answer returned by ask_user or wait_for_answer. Call only after reading that answer, then continue the task.',
      inputSchema: { question_id: QUESTION_ID }
    },
    async ({ question_id }) => {
      const result = await acknowledge(question_id)
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result) }],
        structuredContent: { ...result }
      }
    }
  )
  return server
}
