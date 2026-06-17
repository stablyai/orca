import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import {
  askOperator,
  fetchSessionInfo,
  resolveSessionEnv,
  sendMatrixMessage,
  type OrcaSessionEnv
} from './hook-bridge'

// The agent only ever sees these tools when Orca injected this MCP server at
// launch, so the descriptions scope the agent: relay to the operator, nothing
// else. Kept identical on both tools so the model reads the same boundary.
const SESSION_PREAMBLE =
  'You are running inside an Orca session. Use this only to relay a message to ' +
  "the operator's Matrix room; do not use it for anything else."

const SEND_TOOL_NAME = 'orca_send_message'
const SESSION_INFO_TOOL_NAME = 'orca_session_info'
const ASK_TOOL_NAME = 'orca_ask_operator'

// Default ask timeout in seconds; the hook server clamps to [5, 1800].
const DEFAULT_ASK_TIMEOUT_SECONDS = 300

type ToolResult = {
  content: { type: 'text'; text: string }[]
  isError?: boolean
}

function textResult(text: string, isError = false): ToolResult {
  return { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) }
}

// Surfaces the "not in an Orca session" condition loudly as a tool error so the
// agent reports it rather than silently doing nothing.
function notInSessionResult(error: string): ToolResult {
  return textResult(error, true)
}

async function runSendMessage(session: OrcaSessionEnv, message: string): Promise<ToolResult> {
  const trimmed = message.trim()
  if (!trimmed) {
    return textResult('message must not be empty.', true)
  }
  const result = await sendMatrixMessage(session, trimmed)
  if (result.ok) {
    return textResult(
      `Sent to the operator's Matrix room as [orca ${result.handle}]. ` +
        `The operator can reply by prefixing their message with "@${result.handle} ".`
    )
  }
  return textResult(`Failed to send Matrix message: ${result.error}`, true)
}

async function runAskOperator(
  session: OrcaSessionEnv,
  question: string,
  timeoutSeconds: number
): Promise<ToolResult> {
  const trimmed = question.trim()
  if (!trimmed) {
    return textResult('question must not be empty.', true)
  }
  const result = await askOperator(session, trimmed, timeoutSeconds * 1000)
  if (!result.ok) {
    return textResult(`Failed to ask the operator: ${result.error}`, true)
  }
  if (result.answered) {
    return textResult(result.answer)
  }
  // isError so the agent knows it got no answer and must proceed without one,
  // rather than treating an empty/normal result as a non-answer it can ignore.
  if (result.reason === 'superseded') {
    return textResult(
      'This question was superseded by a newer ask for this session; no answer was received.',
      true
    )
  }
  return textResult(
    `No answer from the operator within ${timeoutSeconds}s. Proceed without one.`,
    true
  )
}

async function runSessionInfo(session: OrcaSessionEnv): Promise<ToolResult> {
  const result = await fetchSessionInfo(session)
  if (!result.ok) {
    return textResult(`Failed to read Orca session info: ${result.error}`, true)
  }
  const { handle, roomId, enabled } = result.info
  const reply =
    handle !== null
      ? `Operator replies are routed to this session when they start with "@${handle} ".`
      : 'No handle has been minted for this session yet.'
  return textResult(JSON.stringify({ handle, roomId, enabled, replyHint: reply }))
}

// Builds the MCP server with the two relay tools. Exported so tests can drive
// the same instance over an in-memory transport.
export function createMatrixMcpServer(env: NodeJS.ProcessEnv = process.env): McpServer {
  const server = new McpServer(
    { name: 'orca-matrix', version: '1.0.0' },
    {
      instructions: `${SESSION_PREAMBLE} Call orca_session_info to learn the reply handle and room before relaying.`
    }
  )

  server.registerTool(
    SEND_TOOL_NAME,
    {
      title: 'Send a message to the Orca operator (Matrix)',
      description: `${SESSION_PREAMBLE} Relays one message to the operator's shared Matrix room, tagged with this session's handle.`,
      inputSchema: {
        message: z.string().describe('The message to relay to the operator.')
      }
    },
    async ({ message }) => {
      const resolved = resolveSessionEnv(env)
      if (!resolved.ok) {
        return notInSessionResult(resolved.error)
      }
      return runSendMessage(resolved.env, message)
    }
  )

  server.registerTool(
    ASK_TOOL_NAME,
    {
      title: 'Ask the Orca operator a question and wait for the reply (Matrix)',
      description:
        `${SESSION_PREAMBLE} Posts a question to the operator's shared Matrix room (tagged ` +
        "with this session's handle) and BLOCKS until the operator replies in the room or the " +
        "timeout elapses, then returns the operator's answer. Use only when you genuinely need " +
        'an answer before continuing; if it times out you must proceed without one.',
      inputSchema: {
        question: z.string().describe('The question to ask the operator.'),
        timeoutSeconds: z
          .number()
          .optional()
          .describe(
            'How long to wait for a reply, in seconds (default 300; the server clamps to 5–1800).'
          )
      }
    },
    async ({ question, timeoutSeconds }) => {
      const resolved = resolveSessionEnv(env)
      if (!resolved.ok) {
        return notInSessionResult(resolved.error)
      }
      return runAskOperator(resolved.env, question, timeoutSeconds ?? DEFAULT_ASK_TIMEOUT_SECONDS)
    }
  )

  server.registerTool(
    SESSION_INFO_TOOL_NAME,
    {
      title: 'Get this Orca session’s Matrix info',
      description: `${SESSION_PREAMBLE} Returns this session's handle, the operator's room id, and whether the Matrix adapter is enabled, so you can tell the operator how to reply (@<handle> …).`,
      inputSchema: {}
    },
    async () => {
      const resolved = resolveSessionEnv(env)
      if (!resolved.ok) {
        return notInSessionResult(resolved.error)
      }
      return runSessionInfo(resolved.env)
    }
  )

  return server
}

// Starts the stdio MCP server and resolves only when the transport closes
// (stdin EOF / SIGTERM). The CLI handler awaits this so the process stays alive
// for the lifetime of the agent that spawned it.
export async function runMatrixMcpServer(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const server = createMatrixMcpServer(env)
  const transport = new StdioServerTransport()
  await server.connect(transport)
  await new Promise<void>((resolve) => {
    transport.onclose = (): void => resolve()
  })
}

export { SEND_TOOL_NAME, SESSION_INFO_TOOL_NAME, ASK_TOOL_NAME }
