// MCP server over Streamable HTTP (spec 2025-11-25, backwards compatible to 2025-03-26), stateless:
// every POST /mcp carries its own bearer token and is answered with a single JSON body (no SSE, no
// Mcp-Session-Id). Only the tools capability is offered; tools map onto the public API (tools.ts).
import type { ApiCaller } from '../api/caller'
import { callTool, hasTool, toolError, toolList, type ApiCall } from './tools'

export const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'] as const
const MAX_BODY_BYTES = 256 * 1024

const SERVER_INFO = {
  name: 'orca-cloud',
  title: 'Orca Cloud',
  version: '1.0.0',
  websiteUrl: 'https://onorca.dev'
}

const INSTRUCTIONS =
  'Orca Cloud runs coding agents (Claude Code, Codex) in cloud workspaces. Typical flow: list_projects or list_workspaces; ' +
  'create_workspace (optionally with a first message); send_message to give an agent a task; list_sessions to read its progress; ' +
  'sleep_workspace when idle and destroy_workspace when done. Destroying is permanent.'

type JsonRpcId = string | number | null
type JsonRpcMessage = { jsonrpc?: unknown; id?: JsonRpcId; method?: unknown; params?: unknown; result?: unknown; error?: unknown }

const PARSE_ERROR = -32700
const INVALID_REQUEST = -32600
const METHOD_NOT_FOUND = -32601
const INVALID_PARAMS = -32602
const INTERNAL_ERROR = -32603

function rpcError(id: JsonRpcId, code: number, message: string, data?: unknown) {
  return { jsonrpc: '2.0', id, error: { code, message, ...(data === undefined ? {} : { data }) } }
}

function rpcResult(id: JsonRpcId, result: unknown) {
  return { jsonrpc: '2.0', id, result }
}

export type McpContext = {
  caller: ApiCaller
  api: ApiCall
  /** Extra response headers (CORS) for browser-based clients. */
  headers: Record<string, string>
}

function jsonResponse(body: unknown, status: number, headers: Record<string, string>): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers } })
}

export function negotiateVersion(requested: unknown): string {
  return typeof requested === 'string' && (PROTOCOL_VERSIONS as readonly string[]).includes(requested) ? requested : PROTOCOL_VERSIONS[0]
}

async function handleMessage(message: JsonRpcMessage, ctx: McpContext): Promise<object | null> {
  const isRequest = message.id !== undefined && message.id !== null && typeof message.method === 'string'
  if (message.jsonrpc !== '2.0' || (message.id !== undefined && message.id !== null && typeof message.id !== 'string' && typeof message.id !== 'number')) {
    return rpcError(message.id ?? null, INVALID_REQUEST, 'Invalid Request')
  }
  if (!isRequest) {
    // Notifications (notifications/initialized, cancelled, ...) and client responses: nothing to say.
    return typeof message.method === 'string' || 'result' in message || 'error' in message ? null : rpcError(null, INVALID_REQUEST, 'Invalid Request')
  }
  const id = message.id as string | number
  const params = (message.params && typeof message.params === 'object' ? message.params : {}) as Record<string, unknown>
  switch (message.method) {
    case 'initialize':
      return rpcResult(id, {
        protocolVersion: negotiateVersion(params.protocolVersion),
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS
      })
    case 'ping':
      return rpcResult(id, {})
    case 'tools/list':
      return rpcResult(id, { tools: toolList() })
    case 'tools/call': {
      const name = params.name
      if (typeof name !== 'string' || !hasTool(name)) {
        return rpcError(id, INVALID_PARAMS, `Unknown tool: ${typeof name === 'string' ? name.slice(0, 64) : '(missing)'}`)
      }
      try {
        return rpcResult(id, await callTool(name, params.arguments, ctx.api))
      } catch (error) {
        // Lifecycle/provider failures the API could not map: report as a tool error, never a stack.
        console.log(JSON.stringify({ event: 'mcp_tool_failed', tool: name, error: String(error).slice(0, 200) }))
        return rpcResult(id, toolError('internal_error', { hint: 'Orca Cloud hit an unexpected error; retry shortly.' }))
      }
    }
    default:
      return rpcError(id, METHOD_NOT_FOUND, 'Method not found')
  }
}

/** POST /mcp for an authenticated caller. */
export async function handleMcpPost(request: Request, ctx: McpContext): Promise<Response> {
  const headers = ctx.headers
  const contentType = request.headers.get('content-type') ?? ''
  if (!/^application\/json\b/i.test(contentType)) {
    return jsonResponse(rpcError(null, INVALID_REQUEST, 'Content-Type must be application/json'), 415, headers)
  }
  const text = await request.text()
  if (text.length > MAX_BODY_BYTES) {
    return jsonResponse(rpcError(null, INVALID_REQUEST, 'Request too large'), 413, headers)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return jsonResponse(rpcError(null, PARSE_ERROR, 'Parse error'), 400, headers)
  }
  const batch = Array.isArray(parsed)
  const messages = (batch ? parsed : [parsed]) as JsonRpcMessage[]
  if (messages.length === 0 || messages.length > 20 || messages.some((m) => !m || typeof m !== 'object' || Array.isArray(m))) {
    return jsonResponse(rpcError(null, INVALID_REQUEST, 'Invalid Request'), 400, headers)
  }
  const initializing = messages.some((m) => m.method === 'initialize')
  const headerVersion = request.headers.get('mcp-protocol-version')
  if (!initializing && headerVersion && !(PROTOCOL_VERSIONS as readonly string[]).includes(headerVersion)) {
    return jsonResponse(rpcError(null, INVALID_REQUEST, `Unsupported MCP-Protocol-Version: ${headerVersion.slice(0, 32)}`, { supported: PROTOCOL_VERSIONS }), 400, headers)
  }
  const replies: object[] = []
  for (const message of messages) {
    try {
      const reply = await handleMessage(message, ctx)
      if (reply) replies.push(reply)
    } catch {
      replies.push(rpcError(typeof message.id === 'string' || typeof message.id === 'number' ? message.id : null, INTERNAL_ERROR, 'Internal error'))
    }
  }
  if (replies.length === 0) {
    return new Response(null, { status: 202, headers })
  }
  return jsonResponse(batch ? replies : replies[0], 200, headers)
}
