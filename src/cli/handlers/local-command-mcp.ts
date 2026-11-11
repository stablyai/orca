import { createInterface } from 'node:readline'
import type { Readable, Writable } from 'node:stream'
import {
  LOCAL_COMMAND_DEFAULT_TIMEOUT_SEC,
  LOCAL_COMMAND_MAX_COMMAND_CHARS,
  LOCAL_COMMAND_MAX_CWD_CHARS,
  LOCAL_COMMAND_MAX_TIMEOUT_SEC,
  LOCAL_COMMAND_MCP_SERVER_NAME,
  LOCAL_COMMAND_MCP_TOOL_NAME,
  LOCAL_COMMAND_REASON_MAX,
  type LocalCommandStatusResult
} from '../../shared/local-commands/local-command-contract'
import { RuntimeClientError } from '../runtime/types'
import {
  explainLocalCommandError,
  formatLocalCommandOutcome,
  type LocalCommandInput
} from './local-command-request'

const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05']

const TOOL = {
  name: LOCAL_COMMAND_MCP_TOOL_NAME,
  title: "Run a command on the person's computer",
  description: [
    "Runs one shell command on the person's own computer (usually a Mac), not in this cloud workspace.",
    'Use it only for things that exist only there: iOS simulators, Xcode, local devices, the keychain, files outside this repository.',
    'The person sees the exact command and folder and must approve each run, so ask for one clear command at a time.',
    'It runs with /bin/sh in a minimal environment (PATH, HOME, locale; no secrets), with no input and a timeout.',
    'Output is cut at 128 KB per stream. It fails if their Orca app is closed or they have not turned local commands on.'
  ].join(' '),
  inputSchema: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: 'The exact shell command. Plain text only.',
        maxLength: LOCAL_COMMAND_MAX_COMMAND_CHARS
      },
      cwd: {
        type: 'string',
        description:
          "Absolute folder on the person's computer, or ~/... Defaults to their home folder.",
        maxLength: LOCAL_COMMAND_MAX_CWD_CHARS
      },
      timeout_sec: {
        type: 'integer',
        minimum: 1,
        maximum: LOCAL_COMMAND_MAX_TIMEOUT_SEC,
        description: `Stops the command after this many seconds (default ${LOCAL_COMMAND_DEFAULT_TIMEOUT_SEC}).`
      },
      reason: {
        type: 'string',
        description: 'One short sentence the person sees: why this needs their computer.',
        maxLength: LOCAL_COMMAND_REASON_MAX
      }
    },
    required: ['command'],
    additionalProperties: false
  },
  annotations: { destructiveHint: true, openWorldHint: true }
} as const

type JsonRpcMessage = {
  jsonrpc?: string
  id?: string | number | null
  method?: string
  params?: unknown
}

export type LocalCommandMcpDeps = {
  input: Readable
  output: Writable
  run: (input: LocalCommandInput) => Promise<LocalCommandStatusResult>
  version?: string
}

function field(value: unknown, name: string): unknown {
  return value !== null && typeof value === 'object' && name in value
    ? Object.getOwnPropertyDescriptor(value, name)?.value
    : undefined
}

type JsonRpcId = string | number | null | undefined
type JsonRpcReply =
  | { id: JsonRpcId; result: unknown }
  | { id: JsonRpcId; error: { code: number; message: string } }

function asMessage(value: unknown): JsonRpcMessage | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }
  const id = field(value, 'id')
  const method = field(value, 'method')
  return {
    id: typeof id === 'string' || typeof id === 'number' ? id : null,
    method: typeof method === 'string' ? method : undefined,
    params: field(value, 'params')
  }
}

/** Tool arguments, checked here so a bad call gets a tool error the agent can read. */
export function parseLocalCommandToolArguments(args: unknown): LocalCommandInput | string {
  const command = field(args, 'command')
  const cwd = field(args, 'cwd')
  const timeout = field(args, 'timeout_sec')
  const reason = field(args, 'reason')
  if (typeof command !== 'string' || command.trim().length === 0) {
    return 'command is required.'
  }
  if (cwd !== undefined && typeof cwd !== 'string') {
    return 'cwd must be a string.'
  }
  if (
    timeout !== undefined &&
    (typeof timeout !== 'number' ||
      !Number.isInteger(timeout) ||
      timeout < 1 ||
      timeout > LOCAL_COMMAND_MAX_TIMEOUT_SEC)
  ) {
    return `timeout_sec must be a whole number from 1 to ${LOCAL_COMMAND_MAX_TIMEOUT_SEC}.`
  }
  if (reason !== undefined && typeof reason !== 'string') {
    return 'reason must be a string.'
  }
  return {
    command,
    ...(cwd ? { cwd } : {}),
    ...(typeof timeout === 'number' ? { timeoutSec: timeout } : {}),
    ...(reason ? { reason: reason.slice(0, LOCAL_COMMAND_REASON_MAX) } : {})
  }
}

/** A minimal MCP stdio server (newline-delimited JSON-RPC) with one tool. Resolves on stdin end. */
export function serveLocalCommandMcp(deps: LocalCommandMcpDeps): Promise<void> {
  const write = (message: JsonRpcReply): void => {
    deps.output.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
  }
  const reply = (id: JsonRpcMessage['id'], result: unknown): void => write({ id, result })
  const fail = (id: JsonRpcMessage['id'], code: number, message: string): void =>
    write({ id, error: { code, message } })

  const callTool = async (id: JsonRpcMessage['id'], params: unknown): Promise<void> => {
    if (field(params, 'name') !== LOCAL_COMMAND_MCP_TOOL_NAME) {
      fail(id, -32602, `Unknown tool: ${String(field(params, 'name'))}`)
      return
    }
    const parsed = parseLocalCommandToolArguments(field(params, 'arguments'))
    if (typeof parsed === 'string') {
      reply(id, { content: [{ type: 'text', text: parsed }], isError: true })
      return
    }
    try {
      const formatted = formatLocalCommandOutcome(await deps.run(parsed))
      reply(id, { content: [{ type: 'text', text: formatted.text }], isError: formatted.isError })
    } catch (error) {
      const explained = explainLocalCommandError(error)
      const text =
        explained instanceof RuntimeClientError || explained instanceof Error
          ? explained.message
          : String(explained)
      reply(id, { content: [{ type: 'text', text }], isError: true })
    }
  }

  const handle = (message: JsonRpcMessage): void => {
    const { id, method } = message
    const isRequest = id !== undefined && id !== null
    switch (method ?? '') {
      case 'initialize': {
        const requested = field(message.params, 'protocolVersion')
        reply(id, {
          protocolVersion:
            typeof requested === 'string' && SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
              ? requested
              : SUPPORTED_PROTOCOL_VERSIONS[0],
          capabilities: { tools: {} },
          serverInfo: { name: LOCAL_COMMAND_MCP_SERVER_NAME, version: deps.version ?? '1.0.0' }
        })
        return
      }
      case 'ping':
        reply(id, {})
        return
      case 'tools/list':
        reply(id, { tools: [TOOL] })
        return
      case 'tools/call':
        // Calls wait minutes for a person; keep answering pings and other calls meanwhile.
        void callTool(id, message.params)
        return
      default:
        if (isRequest) {
          fail(id, -32601, `Method not found: ${String(method)}`)
        }
    }
  }

  return new Promise((resolve) => {
    const lines = createInterface({ input: deps.input, crlfDelay: Infinity })
    lines.on('line', (line) => {
      if (!line.trim()) {
        return
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      } catch {
        write({ id: null, error: { code: -32700, message: 'Parse error' } })
        return
      }
      const message = asMessage(parsed)
      if (message) {
        handle(message)
      }
    })
    lines.on('close', () => resolve())
  })
}
