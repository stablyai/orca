#!/usr/bin/env node
// Stdio MCP server exposing component fixture listing and screenshots to agents.
// Newline-delimited JSON-RPC 2.0; stdout carries protocol frames only.
import { readFile } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { callFixtureServer, ensureFixtureServer } from './fixture-server-client.mjs'

const MAX_INLINE_IMAGES = 6
const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05']

const TOOLS = [
  {
    name: 'list_fixtures',
    description:
      'List Orca renderer component fixtures (*.fixture.tsx). Ids look like "sidebar/DeleteWorktreeDirtyChangeHint:dirty".',
    inputSchema: {
      type: 'object',
      properties: {
        filter: { type: 'string', description: 'Optional substring to filter fixture ids.' }
      }
    }
  },
  {
    name: 'screenshot_fixture',
    description:
      'Render component fixtures headlessly and return PNG screenshots. Accepts an exact id, a component id (all its fixtures), or a glob with *.',
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'Fixture id, component id, or glob (e.g. "sidebar/*").'
        },
        theme: { type: 'string', enum: ['dark', 'light', 'both'], default: 'dark' },
        scale: { type: 'number', description: 'Device pixel ratio (default 1).', default: 1 }
      },
      required: ['id']
    }
  }
]

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function textResult(text, isError = false) {
  return { content: [{ type: 'text', text }], isError }
}

async function listFixturesTool(args) {
  const { url } = await ensureFixtureServer()
  const { fixtures } = await callFixtureServer(url, 'list')
  const filter = typeof args.filter === 'string' ? args.filter : ''
  const lines = fixtures
    .filter((fixture) => fixture.id.includes(filter))
    .map((fixture) => `${fixture.id}\t${fixture.file}`)
  return textResult(lines.join('\n') || 'No fixtures match.')
}

async function screenshotFixtureTool(args) {
  if (typeof args.id !== 'string' || !args.id) {
    return textResult('`id` is required.', true)
  }
  const { url } = await ensureFixtureServer()
  const payload = await callFixtureServer(url, 'shot', {
    ids: [args.id],
    theme: args.theme ?? 'dark',
    scale: args.scale ?? 1
  })
  if (payload.error) {
    return textResult(`${payload.error}\nKnown fixtures: ${payload.knownIds?.join(', ')}`, true)
  }
  const content = []
  let inlined = 0
  for (const result of payload.results) {
    const errors = result.pageErrors?.length
      ? `\npage errors:\n${result.pageErrors.join('\n')}`
      : ''
    if (result.error) {
      content.push({
        type: 'text',
        text: `FAIL ${result.id} [${result.theme}]: ${result.error}${errors}`
      })
      continue
    }
    content.push({ type: 'text', text: `${result.id} [${result.theme}] ${result.path}${errors}` })
    if (inlined < MAX_INLINE_IMAGES) {
      inlined += 1
      const data = (await readFile(result.path)).toString('base64')
      content.push({ type: 'image', data, mimeType: 'image/png' })
    }
  }
  return { content, isError: payload.results.some((result) => result.error) }
}

async function handleRequest(message) {
  switch (message.method) {
    case 'initialize': {
      const requested = message.params?.protocolVersion
      return {
        protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
          ? requested
          : SUPPORTED_PROTOCOL_VERSIONS[0],
        capabilities: { tools: {} },
        serverInfo: { name: 'orca-component-fixtures', version: '0.1.0' }
      }
    }
    case 'ping':
      return {}
    case 'tools/list':
      return { tools: TOOLS }
    case 'tools/call': {
      const args = message.params?.arguments ?? {}
      try {
        if (message.params?.name === 'list_fixtures') {
          return await listFixturesTool(args)
        }
        if (message.params?.name === 'screenshot_fixture') {
          return await screenshotFixtureTool(args)
        }
        return textResult(`Unknown tool ${message.params?.name}`, true)
      } catch (error) {
        return textResult(String(error?.message ?? error), true)
      }
    }
    default:
      throw Object.assign(new Error(`Method not found: ${message.method}`), { code: -32601 })
  }
}

const lines = createInterface({ input: process.stdin })
lines.on('line', (line) => {
  if (!line.trim()) {
    return
  }
  let message
  try {
    message = JSON.parse(line)
  } catch {
    send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })
    return
  }
  // Notifications (no id) such as notifications/initialized need no reply.
  if (message.id === undefined || message.id === null) {
    return
  }
  handleRequest(message)
    .then((result) => send({ jsonrpc: '2.0', id: message.id, result }))
    .catch((error) =>
      send({
        jsonrpc: '2.0',
        id: message.id,
        error: { code: error.code ?? -32603, message: String(error?.message ?? error) }
      })
    )
})
