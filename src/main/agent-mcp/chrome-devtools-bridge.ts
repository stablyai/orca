import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { resolveCliCommand } from '../../shared/node-cli-command-resolution'
import { CHROME_DEVTOOLS_ARGS } from './chrome-devtools-config'
import { ChromeDevtoolsTransport } from './chrome-devtools-transport'

export const CHROME_DEVTOOLS_TIMEOUT_MS = 120_000
export type ChromeDevtoolsBridgeOptions = {
  transport?: Transport
  timeoutMs?: number
}

export async function withChromeDevtools<T>(
  action: (client: Client, timeoutMs: number) => Promise<T>,
  options: ChromeDevtoolsBridgeOptions = {}
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? CHROME_DEVTOOLS_TIMEOUT_MS
  const transport =
    options.transport ??
    new ChromeDevtoolsTransport({
      program: resolveCliCommand('npx'),
      args: CHROME_DEVTOOLS_ARGS,
      env: process.env
    })
  const client = new Client({ name: 'orca-chrome-devtools', version: '1.0.0' })
  const interrupt = (): void => {
    void client.close()
  }
  process.once('SIGINT', interrupt)
  process.once('SIGTERM', interrupt)
  try {
    await client.connect(transport, { timeout: timeoutMs })
    return await action(client, timeoutMs)
  } finally {
    process.removeListener('SIGINT', interrupt)
    process.removeListener('SIGTERM', interrupt)
    await client.close()
    await transport.close()
  }
}

export async function listChromeDevtoolsToolsFromClient(
  client: Client,
  timeoutMs: number
): Promise<{
  tools: Awaited<ReturnType<Client['listTools']>>['tools']
}> {
  const tools: Awaited<ReturnType<Client['listTools']>>['tools'] = []
  const cursors = new Set<string>()
  let cursor: string | undefined
  do {
    const result = await client.listTools(cursor ? { cursor } : {}, { timeout: timeoutMs })
    tools.push(...result.tools)
    cursor = result.nextCursor
    if (cursor && cursors.has(cursor)) {
      throw new Error('Chrome DevTools MCP repeated a tools pagination cursor.')
    }
    if (cursor) {
      cursors.add(cursor)
    }
  } while (cursor)
  return { tools }
}

export async function listChromeDevtoolsTools(options?: ChromeDevtoolsBridgeOptions): Promise<{
  tools: Awaited<ReturnType<Client['listTools']>>['tools']
}> {
  return withChromeDevtools(listChromeDevtoolsToolsFromClient, options)
}

export async function callChromeDevtoolsTool(
  tool: string,
  args: Record<string, unknown>,
  options?: ChromeDevtoolsBridgeOptions
): Promise<Awaited<ReturnType<Client['callTool']>>> {
  return withChromeDevtools(
    (client, timeoutMs) =>
      client.callTool({ name: tool, arguments: args }, CallToolResultSchema, {
        timeout: timeoutMs
      }),
    options
  )
}
