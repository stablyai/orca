import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js'
import { isRecord } from './chrome-devtools-config'
import {
  withChromeDevtools,
  listChromeDevtoolsToolsFromClient,
  type ChromeDevtoolsBridgeOptions
} from './chrome-devtools-bridge'

class InvalidSessionRequest extends Error {}

export type ChromeDevtoolsSessionResponse = {
  id: string | number | null
  ok: boolean
  result?: unknown
  error?: { message: string }
}

async function handleRequest(
  client: Client,
  timeoutMs: number,
  request: unknown
): Promise<unknown> {
  if (!isRecord(request)) {
    throw new InvalidSessionRequest('Each session request must be a JSON object.')
  }
  if (request.type === 'tools') {
    return listChromeDevtoolsToolsFromClient(client, timeoutMs)
  }
  if (request.type !== 'call' || typeof request.tool !== 'string' || !request.tool.trim()) {
    throw new InvalidSessionRequest('Use {type:"tools"} or {type:"call",tool:"name",arguments:{}}.')
  }
  if (request.arguments !== undefined && !isRecord(request.arguments)) {
    throw new InvalidSessionRequest('Tool arguments must be a JSON object.')
  }
  return client.callTool(
    { name: request.tool, arguments: request.arguments ?? {} },
    CallToolResultSchema,
    { timeout: timeoutMs }
  )
}

export async function runChromeDevtoolsSession(
  lines: AsyncIterable<string>,
  respond: (response: ChromeDevtoolsSessionResponse) => void,
  options?: ChromeDevtoolsBridgeOptions
): Promise<void> {
  // Attach before the MCP handshake so piped input is buffered during startup.
  const iterator = lines[Symbol.asyncIterator]()
  await withChromeDevtools(async (client, timeoutMs) => {
    for await (const line of { [Symbol.asyncIterator]: () => iterator }) {
      if (!line.trim()) {
        continue
      }
      let id: ChromeDevtoolsSessionResponse['id'] = null
      let response: ChromeDevtoolsSessionResponse
      let fatal = false
      try {
        const request: unknown = JSON.parse(line)
        if (
          isRecord(request) &&
          (typeof request.id === 'string' || typeof request.id === 'number')
        ) {
          id = request.id
        }
        const result = await handleRequest(client, timeoutMs, request)
        response = { id, ok: !(isRecord(result) && result.isError === true), result }
      } catch (error) {
        fatal = !(error instanceof SyntaxError || error instanceof InvalidSessionRequest)
        response = {
          id,
          ok: false,
          error: { message: error instanceof Error ? error.message : String(error) }
        }
      }
      respond(response)
      if (fatal) {
        break
      }
    }
  }, options)
}
