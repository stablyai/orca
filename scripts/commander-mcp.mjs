#!/usr/bin/env node
import { parseArgs } from 'node:util'
import { z } from 'zod'
import { registerCommanderMemoryTools } from './commander-memory-tools.mjs'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  ErrorCode,
  McpError,
  SubscribeRequestSchema,
  UnsubscribeRequestSchema
} from '@modelcontextprotocol/sdk/types.js'
import { collectCommanderBriefing } from './commander-briefing.mjs'

const uri = 'orca://commander/briefing'
const description =
  'Read registered Orca projects, goal progress, pending decisions and collection errors.'
const server = new McpServer({ name: 'orca-commander', version: '0.1.0' })
const { values } = parseArgs({
  options: {
    environment: { type: 'string' },
    cli: { type: 'string' },
    repo: { type: 'string' },
    'memory-grant': { type: 'string' }
  }
})

if (values['memory-grant']) {
  registerCommanderMemoryTools(server, values['memory-grant'])
}
server.registerTool(
  'commander_code_graph',
  {
    description:
      'Inspect tracked JavaScript and TypeScript files and their relative imports in the configured checkout.',
    annotations: { readOnlyHint: true, openWorldHint: false },
    inputSchema: {
      scope: z.string().optional(),
      maxFiles: z.number().int().min(1).max(200).optional()
    }
  },
  async (args) => {
    const { collectCommanderCodeGraph } = await import('./commander-code-graph.mjs')
    const graph = await collectCommanderCodeGraph({ cwd: values.repo ?? process.cwd(), ...args })
    return { content: [{ type: 'text', text: JSON.stringify(graph) }] }
  }
)

let pending
async function snapshot() {
  pending ??= collectCommanderBriefing(values)
    .then((briefing) => ({ text: JSON.stringify(briefing), isError: false }))
    .catch((error) => ({ text: JSON.stringify({ error: error.message }), isError: true }))
    .finally(() => {
      pending = undefined
    })
  return pending
}

server.registerTool(
  'commander_briefing',
  {
    description,
    annotations: { readOnlyHint: true, openWorldHint: false }
  },
  async () => {
    const { text, isError } = await snapshot()
    return { content: [{ type: 'text', text }], isError }
  }
)
server.registerResource(
  'commander-briefing',
  uri,
  { description, mimeType: 'application/json' },
  async () => {
    const { text } = await snapshot()
    return { contents: [{ uri, mimeType: 'application/json', text }] }
  }
)

function checkUri(request) {
  if (request.params.uri !== uri) {
    throw new McpError(ErrorCode.InvalidParams, 'Unknown Commander resource.')
  }
}

let subscription
async function watch(current) {
  const { text } = await snapshot()
  if (subscription !== current) {
    return
  }
  try {
    if (current.text !== undefined && text !== current.text) {
      await server.server.sendResourceUpdated({ uri })
    }
    current.text = text
  } finally {
    if (subscription === current) {
      current.timer = setTimeout(() => watch(current).catch(stopWatching), 30_000).unref()
    }
  }
}

function stopWatching() {
  clearTimeout(subscription?.timer)
  subscription = undefined
}

server.server.registerCapabilities({ resources: { subscribe: true } })
server.server.setRequestHandler(SubscribeRequestSchema, async (request) => {
  checkUri(request)
  if (!subscription) {
    subscription = {}
    await watch(subscription)
  }
  return {}
})
server.server.setRequestHandler(UnsubscribeRequestSchema, async (request) => {
  checkUri(request)
  stopWatching()
  return {}
})
process.stdin.once('end', stopWatching)
server.server.onclose = stopWatching
await server.connect(new StdioServerTransport())
