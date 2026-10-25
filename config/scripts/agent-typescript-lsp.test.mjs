import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  createDiagnosticsBridge,
  createLspMessageReader,
  encodeLspMessage
} from './agent-typescript-lsp.mjs'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))
const uri = 'file:///repo/src/a.ts'

function harness(clientCapabilities) {
  const client = []
  const server = []
  const timers = new Map()
  let nextTimer = 0
  const bridge = createDiagnosticsBridge({
    toClient: (message) => client.push(message),
    toServer: (message) => server.push(message),
    setTimer: (run) => {
      timers.set(++nextTimer, run)
      return nextTimer
    },
    clearTimer: (id) => timers.delete(id)
  })
  bridge.fromClient({
    jsonrpc: '2.0',
    id: 0,
    method: 'initialize',
    params: { capabilities: clientCapabilities }
  })
  const flush = () => {
    const pending = [...timers.values()]
    timers.clear()
    pending.forEach((run) => run())
  }
  const pulls = () => server.filter((message) => message.method === 'textDocument/diagnostic')
  const pushes = () =>
    client.filter((message) => message.method === 'textDocument/publishDiagnostics')
  return { bridge, client, server, flush, pulls, pushes }
}

const edit = (version) => ({
  jsonrpc: '2.0',
  method: 'textDocument/didChange',
  params: { textDocument: { uri, version }, contentChanges: [{ text: `v${version}` }] }
})
const report = (id, message) => ({
  jsonrpc: '2.0',
  id,
  result: { kind: 'full', items: [{ message }] }
})

describe('agent TypeScript LSP diagnostics bridge', () => {
  it('pushes pulled diagnostics to a push-only client and drops results an edit outdated', () => {
    const { bridge, server, flush, pulls, pushes } = harness({ textDocument: {} })
    expect(server[0].params.capabilities.textDocument.diagnostic).toBeDefined()

    bridge.fromClient({
      jsonrpc: '2.0',
      method: 'textDocument/didOpen',
      params: { textDocument: { uri, version: 1, languageId: 'typescript', text: 'v1' } }
    })
    bridge.fromClient(edit(2))
    flush()
    expect(pulls()).toHaveLength(1)
    const outdated = pulls()[0].id

    bridge.fromClient(edit(3))
    bridge.fromServer(report(outdated, 'stale'))
    expect(pushes()).toEqual([])

    flush()
    bridge.fromServer(report(pulls()[1].id, 'fresh'))
    expect(pushes()).toEqual([
      {
        jsonrpc: '2.0',
        method: 'textDocument/publishDiagnostics',
        params: { uri, version: 3, diagnostics: [{ message: 'fresh' }] }
      }
    ])
  })

  it('re-pulls open documents when the server asks for a refresh', () => {
    const { bridge, client, server, flush, pulls } = harness({})
    bridge.fromClient(edit(1))
    flush()
    bridge.fromServer({ jsonrpc: '2.0', id: 'srv-1', method: 'workspace/diagnostic/refresh' })
    flush()
    expect(pulls()).toHaveLength(2)
    expect(server).toContainEqual({ jsonrpc: '2.0', id: 'srv-1', result: null })
    expect(client.some((message) => message.method === 'workspace/diagnostic/refresh')).toBe(false)
  })

  it('stays out of the way of a client that pulls diagnostics itself', () => {
    const capabilities = { textDocument: { diagnostic: {} } }
    const { bridge, client, server, flush, pulls } = harness(capabilities)
    expect(server[0].params.capabilities).toBe(capabilities)
    bridge.fromClient(edit(1))
    flush()
    expect(pulls()).toEqual([])
    bridge.fromServer({ jsonrpc: '2.0', id: 'srv-1', method: 'workspace/diagnostic/refresh' })
    expect(client.at(-1).method).toBe('workspace/diagnostic/refresh')
  })

  it('reassembles messages split across and packed into stdio chunks', () => {
    const received = []
    const read = createLspMessageReader((message) => received.push(message))
    const frames = Buffer.concat([
      encodeLspMessage({ id: 1, text: 'héllo' }),
      encodeLspMessage({ id: 2 })
    ])
    read(frames.subarray(0, 7))
    read(frames.subarray(7, 30))
    read(frames.subarray(30))
    expect(received).toEqual([{ id: 1, text: 'héllo' }, { id: 2 }])
  })

  it('is the server every committed agent config launches', () => {
    const plugin = JSON.parse(
      readFileSync(join(repoRoot, 'config/agent-plugins/orca-typescript/.lsp.json'), 'utf8')
    )
    const opencode = JSON.parse(readFileSync(join(repoRoot, 'opencode.json'), 'utf8'))
    const script = 'config/scripts/agent-typescript-lsp.mjs'
    expect(existsSync(join(repoRoot, script))).toBe(true)
    expect(plugin['orca-typescript'].args).toEqual([`\${CLAUDE_PROJECT_DIR}/${script}`])
    expect(opencode.lsp['orca-typescript'].command).toEqual(['node', script])
  })
})
