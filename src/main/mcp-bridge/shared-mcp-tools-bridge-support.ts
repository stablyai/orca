import type { StdioServerParameters } from '@modelcontextprotocol/sdk/client/stdio.js'
import type { Progress, ProgressNotification } from '@modelcontextprotocol/sdk/types.js'
import { createHash } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'

export const LOOPBACK_HOST = '127.0.0.1'
export const MCP_PATH = '/mcp'
const MAX_REQUEST_BYTES = 4 * 1024 * 1024

export type SharedMcpStdioDefinition = Pick<
  StdioServerParameters,
  'command' | 'args' | 'cwd' | 'env'
> & {
  /** Caller-owned workspace/auth/version boundary. Different values must never pool. */
  isolationKey?: string
}

export type SharedMcpToolsBridgeOptions = {
  idleTimeoutMs?: number
  token?: string
}

export type SharedMcpToolsBridgeConnection = {
  url: URL
  headers: Readonly<Record<string, string>>
}

export type SharedMcpToolsBridgeStatus = {
  downstreamPid: number | null
  sessionCount: number
}

function canonicalDefinition(definition: SharedMcpStdioDefinition): string {
  return JSON.stringify({
    command: definition.command,
    args: definition.args ?? [],
    cwd: definition.cwd ?? null,
    env: Object.entries(definition.env ?? {}).sort(([left], [right]) => left.localeCompare(right)),
    isolationKey: definition.isolationKey ?? null
  })
}

/** Environment values affect pooling without being exposed in status or logs. */
export function fingerprintSharedMcpDefinition(definition: SharedMcpStdioDefinition): string {
  return createHash('sha256').update(canonicalDefinition(definition)).digest('hex')
}

export function sendJsonError(response: ServerResponse, status: number, message: string): void {
  if (response.headersSent) {
    response.end()
    return
  }
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(
    JSON.stringify({
      jsonrpc: '2.0',
      error: { code: -32000, message },
      id: null
    })
  )
}

export async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > MAX_REQUEST_BYTES) {
      throw new Error('MCP request body is too large')
    }
    chunks.push(buffer)
  }
  if (chunks.length === 0) {
    return undefined
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

export function forwardMcpProgress(
  progress: Progress,
  upstreamToken: string | number | undefined,
  sendNotification: (notification: ProgressNotification) => Promise<void>
): void {
  if (upstreamToken === undefined) {
    return
  }
  void sendNotification({
    method: 'notifications/progress',
    params: { ...progress, progressToken: upstreamToken }
  }).catch(() => undefined)
}
