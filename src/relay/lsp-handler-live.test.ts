// Live integration: the relay `lsp.*` handler spawns a REAL clangd and streams a
// real LSP `initialize` handshake round-trip. Runs only when a `clangd` binary
// is on PATH (CI/dev hosts without clangd skip). Ticket 17 live e2e evidence.
import { spawn } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { LspHandler } from './lsp-handler'
import type { RelayDispatcher, RequestContext } from './dispatcher'
import { LSP_RELAY_METHODS } from '../shared/lsp-relay-channel'

// A minimal real dispatcher stub: captures publishProducerNotification so the
// test reads the actual lsp.data/lsp.exit frames the relay emitted against a
// live clangd. `onDisposed` is a no-op (the test tears down via lsp.kill).
function liveDispatcher() {
  const requestHandlers = new Map<
    string,
    (p: Record<string, unknown>, ctx: RequestContext) => unknown
  >()
  const notificationHandlers = new Map<string, (p: Record<string, unknown>) => void>()
  const notifications: { method: string; params: Record<string, unknown> }[] = []
  return {
    onRequest: (
      method: string,
      handler: (p: Record<string, unknown>, ctx: RequestContext) => unknown
    ) => requestHandlers.set(method, handler),
    onNotification: (method: string, handler: (p: Record<string, unknown>) => void) =>
      notificationHandlers.set(method, handler),
    publishProducerNotification: (
      _clientId: number,
      method: string,
      params?: Record<string, unknown>
    ) => {
      notifications.push({ method, params: params ?? {} })
      return true
    },
    onDisposed: () => () => {},
    _notifications: notifications,
    async callRequest(method: string, params: Record<string, unknown> = {}) {
      const handler = requestHandlers.get(method)
      if (!handler) {
        throw new Error(`Method not found: ${method}`)
      }
      return handler(params, { clientId: 1, isStale: () => false })
    },
    callNotification(method: string, params: Record<string, unknown> = {}) {
      notificationHandlers.get(method)?.(params)
    }
  } as unknown as RelayDispatcher
}

async function clangdAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn('clangd', ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] })
    child.on('error', () => resolve(false))
    child.on('exit', (code) => resolve(code === 0))
    setTimeout(() => {
      try {
        child.kill()
      } catch {
        // already dead
      }
      resolve(false)
    }, 3_000)
  })
}

describe.runIf(await clangdAvailable())('LspHandler live (real clangd)', () => {
  it('spawns clangd, streams an LSP initialize response as lsp.data, and exits on lsp.kill', async () => {
    const dispatcher = liveDispatcher()
    new LspHandler(dispatcher)
    const { sessionId } = (await (
      dispatcher as unknown as {
        callRequest: (m: string, p: Record<string, unknown>) => Promise<unknown>
      }
    ).callRequest(LSP_RELAY_METHODS.spawn, {
      program: 'clangd',
      args: ['--log=verbose']
    })) as { sessionId: string }
    expect(sessionId).toMatch(/^lsp:/)

    // Write a minimal LSP initialize request to clangd's stdin (Content-Length framed).
    const initRequest = {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        processId: process.pid,
        rootUri: null,
        capabilities: { general: { positionEncodings: ['utf-16'] } }
      }
    }
    const body = Buffer.from(JSON.stringify(initRequest), 'utf8')
    const frame = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'utf8')
    ;(
      dispatcher as unknown as { callNotification: (m: string, p: Record<string, unknown>) => void }
    ).callNotification(LSP_RELAY_METHODS.write, {
      sessionId,
      data: Buffer.concat([frame, body]).toString('base64')
    })

    // Wait for clangd to respond (initialize ~100ms; give it room).
    await new Promise((resolve) => setTimeout(resolve, 1_500))

    const dataFrames = (
      dispatcher as unknown as {
        _notifications: { method: string; params: Record<string, unknown> }[]
      }
    )._notifications.filter((n) => n.method === LSP_RELAY_METHODS.data)
    expect(dataFrames.length).toBeGreaterThan(0)
    // Reassemble the stdout chunks and assert a real LSP initialize result landed.
    const reassembled = Buffer.concat(
      dataFrames.map((n) => Buffer.from(n.params.data as string, 'base64'))
    ).toString('utf8')
    expect(reassembled).toContain('Content-Length:')
    expect(reassembled).toContain('"result"')
    expect(reassembled).toMatch(/positionEncoding|capabilities/)

    // Kill clangd; the relay publishes lsp.exit (host-acknowledged death).
    const killResult = (await (
      dispatcher as unknown as {
        callRequest: (m: string, p: Record<string, unknown>) => Promise<unknown>
      }
    ).callRequest(LSP_RELAY_METHODS.kill, { sessionId })) as { killed: boolean }
    expect(killResult.killed).toBe(true)
    // Give the exit notification time to flush.
    await new Promise((resolve) => setTimeout(resolve, 300))
    const exitFrames = (
      dispatcher as unknown as { _notifications: { method: string }[] }
    )._notifications.filter((n) => n.method === LSP_RELAY_METHODS.exit)
    expect(exitFrames.length).toBe(1)
  }, 15_000)
})
