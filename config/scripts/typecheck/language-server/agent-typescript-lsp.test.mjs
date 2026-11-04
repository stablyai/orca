import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  createDiagnosticsBridge,
  createIdleWatchdog,
  createLspMessageReader,
  encodeLspMessage,
  resolveIdleMs
} from './agent-typescript-lsp.mjs'

const repoRoot = fileURLToPath(new URL('../../../..', import.meta.url))
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
    bridge.fromClient({
      jsonrpc: '2.0',
      method: 'textDocument/didOpen',
      params: { textDocument: { uri, version: 1, languageId: 'typescript', text: 'v1' } }
    })
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
    const split = frames.indexOf(Buffer.from('é')) + 1
    read(frames.subarray(7, split))
    read(frames.subarray(split))
    expect(received).toEqual([{ id: 1, text: 'héllo' }, { id: 2 }])
  })

  it('wires Claude and OpenCode to the repository language server', () => {
    const plugin = JSON.parse(
      readFileSync(join(repoRoot, 'config/agent-plugins/orca-typescript/.lsp.json'), 'utf8')
    )
    const opencode = JSON.parse(readFileSync(join(repoRoot, 'opencode.json'), 'utf8'))
    const script = 'config/scripts/typecheck/language-server/agent-typescript-lsp.mjs'
    expect(existsSync(join(repoRoot, script))).toBe(true)
    expect(plugin['orca-typescript'].command).toBe('node')
    expect(plugin['orca-typescript'].args).toEqual([`\${CLAUDE_PROJECT_DIR}/${script}`])
    expect(opencode.lsp['orca-typescript'].command).toEqual(['node', script])
  })
})

describe('idle reaper for a connected but quiet client (#38188)', () => {
  function bridgeWithClient(capabilities) {
    const client = []
    const server = []
    const bridge = createDiagnosticsBridge({
      toClient: (message) => client.push(message),
      toServer: (message) => server.push(message)
    })
    bridge.fromClient({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { capabilities } })
    return bridge
  }

  it('counts open documents even when the client answers pull diagnostics itself', () => {
    // The reaper must not retire a server while a file is open, whether or not this
    // bridge publishes diagnostics for the client.
    const bridge = bridgeWithClient({ textDocument: { diagnostic: {} } })
    expect(bridge.openDocumentCount()).toBe(0)
    bridge.fromClient({
      jsonrpc: '2.0',
      method: 'textDocument/didOpen',
      params: { textDocument: { uri, languageId: 'typescript', version: 1, text: '' } }
    })
    expect(bridge.openDocumentCount()).toBe(1)
    bridge.fromClient({
      jsonrpc: '2.0',
      method: 'textDocument/didClose',
      params: { textDocument: { uri } }
    })
    expect(bridge.openDocumentCount()).toBe(0)
  })

  it('reaps only after the window passes with no message and no open document', () => {
    let nowMs = 0
    const timers = []
    let openDocuments = 1
    const reaped = []
    const watchdog = createIdleWatchdog({
      idleMs: 60_000,
      hasOpenDocuments: () => openDocuments > 0,
      onIdle: () => reaped.push(nowMs),
      now: () => nowMs,
      setTimer: (run, delay) => {
        timers.push({ run, delay, at: nowMs + delay })
        return timers.length
      },
      clearTimer: () => {}
    })
    watchdog.start()

    // Open document: a full window passes, then the watchdog defers another window.
    nowMs = 60_000
    timers.at(-1).run()
    expect(reaped).toEqual([])

    openDocuments = 0
    nowMs = 120_000
    timers.at(-1).run()
    expect(reaped).toEqual([120_000])

    // Traffic within the window keeps the server.
    const fresh = []
    nowMs = 0
    timers.length = 0
    const second = createIdleWatchdog({
      idleMs: 60_000,
      hasOpenDocuments: () => false,
      onIdle: () => fresh.push(nowMs),
      now: () => nowMs,
      setTimer: (run, delay) => {
        timers.push({ run, delay, at: nowMs + delay })
        return timers.length
      },
      clearTimer: () => {}
    })
    second.start()
    nowMs = 50_000
    second.touch()
    nowMs = 100_000
    timers.at(-1).run()
    expect(fresh).toEqual([])
  })

  it('is inert when disabled and defaults to a conservative hour', () => {
    expect(resolveIdleMs('0')).toBe(0)
    expect(resolveIdleMs(undefined)).toBe(60 * 60 * 1000)
    expect(resolveIdleMs('nonsense')).toBe(60 * 60 * 1000)
    expect(resolveIdleMs('90000')).toBe(90_000)

    const reaped = []
    const disabled = createIdleWatchdog({
      idleMs: 0,
      hasOpenDocuments: () => false,
      onIdle: () => reaped.push(true),
      setTimer: () => {
        throw new Error('disabled watchdog must not arm a timer')
      }
    })
    disabled.start()
    disabled.touch()
    expect(reaped).toEqual([])
  })
})
