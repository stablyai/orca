import { createInterface } from 'node:readline'
import type { Readable, Writable } from 'node:stream'
import { MCP_TOOLS } from './mcp-tool-catalog'
import {
  McpToolInputError,
  buildMcpToolArgv,
  isJsonObject,
  describeMcpTool,
  type McpToolDefinition
} from './mcp-tool-input'

export type McpToolRun = { exitCode: number | null; stdout: string; stderr: string }

export type McpToolRunner = (
  tool: McpToolDefinition,
  argv: string[],
  signal: AbortSignal
) => Promise<McpToolRun>

type JsonRpcId = string | number

const SUPPORTED_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']

const PARSE_ERROR = -32700
const INVALID_REQUEST = -32600
const METHOD_NOT_FOUND = -32601
const INVALID_PARAMS = -32602

export const MCP_SERVER_INSTRUCTIONS = [
  'Orca runs coding agents (Claude Code, Codex and others) in its own git worktrees and terminals on this machine. Prefer delegating code work to an Orca agent: it has the whole repository on disk.',
  'Everything is asynchronous. worktree_create with an agent and agent_launch return a handle immediately while the agent keeps working. Poll with worktree_ps (agentWait: true) or terminal_read every 20-30 seconds, or block briefly with terminal_wait (for: tui-idle). Never launch a second agent for work that is still running; that duplicates the work and its cost.',
  'An idle agent is not dead. Idle means it finished its turn and is waiting for input with its session and context intact. To continue it, send a follow-up with terminal_send (enter: true) to the same terminal. A new launch starts without that context.',
  'An agent cannot ask you questions mid-task. Send one self-contained instruction: what done looks like, which files to touch, and how to verify the result.'
].join('\n\n')

export function serveMcpOverStdio(options: {
  input: Readable
  output: Writable
  runTool: McpToolRunner
  version: string
}): Promise<void> {
  const { input, output, runTool, version } = options
  const toolsByName = new Map(MCP_TOOLS.map((tool) => [tool.name, tool]))
  const inFlight = new Map<JsonRpcId, AbortController>()
  const pending = new Set<Promise<void>>()

  const send = (message: Record<string, unknown>): void => {
    output.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
  }
  const sendError = (id: JsonRpcId | null, code: number, message: string): void => {
    send({ id, error: { code, message } })
  }

  const callTool = async (id: JsonRpcId, params: Record<string, unknown>): Promise<void> => {
    const tool = typeof params.name === 'string' ? toolsByName.get(params.name) : undefined
    if (!tool) {
      sendError(id, INVALID_PARAMS, `Unknown tool: ${String(params.name)}`)
      return
    }
    let argv: string[]
    try {
      argv = buildMcpToolArgv(tool, params.arguments)
    } catch (error) {
      if (error instanceof McpToolInputError) {
        send({ id, result: toolResult(error.message, true) })
        return
      }
      throw error
    }
    const controller = new AbortController()
    inFlight.set(id, controller)
    try {
      const run = await runTool(tool, argv, controller.signal)
      // A cancelled request gets no response.
      if (controller.signal.aborted) {
        return
      }
      send({ id, result: toCallToolResult(run) })
    } catch (error) {
      if (!controller.signal.aborted) {
        send({ id, result: toolResult(`Could not run orca: ${errorMessage(error)}`, true) })
      }
    } finally {
      inFlight.delete(id)
    }
  }

  const handle = async (message: Record<string, unknown>): Promise<void> => {
    const id = isJsonRpcId(message.id) ? message.id : null
    if (message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
      // Responses to server requests are not used; drop anything that is not a request.
      if (id !== null && message.method !== undefined) {
        sendError(id, INVALID_REQUEST, 'Invalid JSON-RPC request.')
      }
      return
    }
    const params = isJsonObject(message.params) ? message.params : {}
    if (id === null) {
      if (message.method === 'notifications/cancelled') {
        const requestId = params.requestId
        if (isJsonRpcId(requestId)) {
          inFlight.get(requestId)?.abort()
        }
      }
      return
    }
    switch (message.method) {
      case 'initialize': {
        const requested = params.protocolVersion
        send({
          id,
          result: {
            protocolVersion:
              typeof requested === 'string' && SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
                ? requested
                : SUPPORTED_PROTOCOL_VERSIONS[0],
            capabilities: { tools: {} },
            serverInfo: { name: 'orca', title: 'Orca', version },
            instructions: MCP_SERVER_INSTRUCTIONS
          }
        })
        return
      }
      case 'ping':
        send({ id, result: {} })
        return
      case 'tools/list':
        send({ id, result: { tools: MCP_TOOLS.map(describeMcpTool) } })
        return
      case 'tools/call':
        await callTool(id, params)
        return
      default:
        sendError(id, METHOD_NOT_FOUND, `Method not found: ${message.method}`)
    }
  }

  return new Promise((resolve) => {
    const lines = createInterface({ input, crlfDelay: Infinity })
    lines.on('line', (line) => {
      if (line.trim().length === 0) {
        return
      }
      let message: unknown
      try {
        message = JSON.parse(line)
      } catch {
        sendError(null, PARSE_ERROR, 'Parse error.')
        return
      }
      if (!isJsonObject(message)) {
        sendError(null, INVALID_REQUEST, 'Invalid JSON-RPC request.')
        return
      }
      const task = handle(message).catch((error: unknown) => {
        if (isJsonRpcId(message.id)) {
          sendError(message.id, -32603, errorMessage(error))
        }
      })
      pending.add(task)
      void task.finally(() => pending.delete(task))
    })
    lines.on('close', () => {
      // The client closed stdin: stop running commands, then exit once their replies are dropped.
      for (const controller of inFlight.values()) {
        controller.abort()
      }
      void Promise.allSettled(pending).then(() => resolve())
    })
  })
}

function toCallToolResult(run: McpToolRun): Record<string, unknown> {
  const stdout = run.stdout.trim()
  const stderr = run.stderr.trim()
  // terminal wait exits 1 for an unmet condition but still reports ok: true.
  const ok = run.exitCode === 0 || parsesAsSuccess(stdout)
  const text = (ok ? [stdout || stderr] : [stdout, stderr]).filter(Boolean).join('\n')
  return toolResult(text || `orca exited with code ${String(run.exitCode)}`, !ok)
}

function parsesAsSuccess(stdout: string): boolean {
  try {
    const parsed: unknown = JSON.parse(stdout)
    return isJsonObject(parsed) && parsed.ok === true
  } catch {
    return false
  }
}

function toolResult(text: string, isError: boolean): Record<string, unknown> {
  return { content: [{ type: 'text', text }], isError }
}

function isJsonRpcId(value: unknown): value is JsonRpcId {
  return typeof value === 'string' || typeof value === 'number'
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
