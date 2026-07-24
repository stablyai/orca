import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import http from 'node:http'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  crushOrcaHostArg,
  crushOrcaSocketPath,
  crushSseBridgeSupported,
  crushSseEnabledForLaunch,
  startCrushSseBridge
} from './crush-sse-bridge'
import { crushOrcaSocketFileName } from '../../shared/crush-sse-shapes'

// Why: crushSseEnabledForLaunch branches on process.platform; stub it per test so
// every platform branch is exercised on every host. Restore afterEach.
const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
afterEach(() => {
  if (originalPlatform) {
    Object.defineProperty(process, 'platform', originalPlatform)
  }
})

function stubPlatform(value: 'darwin' | 'linux' | 'win32'): void {
  Object.defineProperty(process, 'platform', { value, configurable: true })
}

describe('crushOrcaSocketPath / crushOrcaHostArg', () => {
  it('builds an absolute socket path and a unix:// --host arg from the same launch token', () => {
    const path = crushOrcaSocketPath('ltok-1')
    const host = crushOrcaHostArg('ltok-1')
    expect(path.endsWith(crushOrcaSocketFileName('ltok-1'))).toBe(true)
    expect(host).toBe(`unix://${path}`)
  })

  it('prefers XDG_RUNTIME_DIR when set and absolute', () => {
    const prev = process.env.XDG_RUNTIME_DIR
    process.env.XDG_RUNTIME_DIR = '/var/run'
    try {
      expect(crushOrcaSocketPath('tok')).toBe(`/var/run/${crushOrcaSocketFileName('tok')}`)
    } finally {
      if (prev === undefined) {
        delete process.env.XDG_RUNTIME_DIR
      } else {
        process.env.XDG_RUNTIME_DIR = prev
      }
    }
  })
})

describe('crushSseEnabledForLaunch', () => {
  it.each(['darwin', 'linux'] as const)(
    'enables SSE for a local crush launch with a token on %s',
    (platform) => {
      stubPlatform(platform)
      expect(
        crushSseEnabledForLaunch({
          launchAgent: 'crush',
          launchToken: 'tok',
          connectionId: undefined
        })
      ).toBe(true)
    }
  )

  it('disables SSE on Windows (Node socketPath transport is unix-only)', () => {
    stubPlatform('win32')
    expect(
      crushSseEnabledForLaunch({
        launchAgent: 'crush',
        launchToken: 'tok',
        connectionId: undefined
      })
    ).toBe(false)
  })

  it('disables SSE for SSH/relay worktrees even on a supported platform', () => {
    stubPlatform('darwin')
    expect(
      crushSseEnabledForLaunch({
        launchAgent: 'crush',
        launchToken: 'tok',
        connectionId: 'ssh-conn-1'
      })
    ).toBe(false)
    // Why: empty-string connectionId is treated as local (the runtime only ever
    // passes a truthy string for remote).
    expect(
      crushSseEnabledForLaunch({
        launchAgent: 'crush',
        launchToken: 'tok',
        connectionId: ''
      })
    ).toBe(true)
  })

  it('disables SSE when the launch token is missing or the agent is not crush', () => {
    stubPlatform('linux')
    expect(
      crushSseEnabledForLaunch({ launchAgent: 'crush', launchToken: '', connectionId: undefined })
    ).toBe(false)
    expect(crushSseEnabledForLaunch({ launchAgent: 'crush', launchToken: undefined })).toBe(false)
    expect(
      crushSseEnabledForLaunch({
        launchAgent: 'claude',
        launchToken: 'tok',
        connectionId: undefined
      })
    ).toBe(false)
  })
})
;(crushSseBridgeSupported() ? describe : describe.skip)('startCrushSseBridge (socket)', () => {
  let server: Server
  let socketPath: string
  let tmp: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'crush-sse-test-'))
    socketPath = join(tmp, 'test.sock')
    server = createServer((req, res) => {
      if (req.url !== '/v1/workspaces/0/events') {
        res.writeHead(404)
        res.end()
        return
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      // Why: write one complete SSE event after a tick so the bridge's
      // socket lookup attempt during connect sees it.
      res.write(
        'data: {"type":"run_complete","payload":{"payload":{"session_id":"s1","text":"hi"}}}\n\n'
      )
    })
    server.listen(socketPath)
  })

  afterEach(() => {
    server?.close()
    rmSync(tmp, { recursive: true, force: true })
  })

  it('connects, parses a run_complete envelope, and forwards it to onEvent', async () => {
    const seen: { hookEventName: string; hookPayload: Record<string, unknown> }[] = []
    await new Promise<void>((resolve) => {
      const bridge = startCrushSseBridge(socketPath, {
        paneKey: 'pk',
        launchToken: 'ltok-1',
        onEvent: (ev) => {
          seen.push(ev)
          bridge.stop()
          resolve()
        },
        onError: (err) => {
          bridge.stop()
          throw err
        }
      })
      // Why: a safety timeout so the test doesn't hang if parsing breaks.
      setTimeout(() => {
        bridge.stop()
        resolve()
      }, 2000)
    })

    expect(seen).toHaveLength(1)
    expect(seen[0].hookEventName).toBe('run_complete')
    expect(seen[0].hookPayload).toEqual({ session_id: 's1', text: 'hi' })
  })

  it('resets the SSE buffer on each reconnect so a mid-stream drop does not corrupt the next stream', async () => {
    // Why: regress here if the bridge stops resetting `buffer` in connect() — a
    // leftover partial fragment would prepend itself to the next stream's bytes
    // and silently drop the first post-reconnect event(s) as malformed JSON.
    const partialPath = join(tmp, 'partial.sock')
    let connectionCount = 0
    const partialServer = createServer((req, res) => {
      if (req.url !== '/v1/workspaces/0/events') {
        res.writeHead(404)
        res.end()
        return
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      connectionCount++
      if (connectionCount === 1) {
        res.write('data: not-yet-termin') // partial — no \n\n terminator
        res.end() // close mid-event → leaves a fragment in the bridge buffer
      } else {
        res.write(
          'data: {"type":"run_complete","payload":{"payload":{"session_id":"s1","text":"hi"}}}\n\n'
        )
      }
    })
    partialServer.listen(partialPath)
    try {
      const seen: { hookEventName: string; hookPayload: Record<string, unknown> }[] = []
      await new Promise<void>((resolve) => {
        const bridge = startCrushSseBridge(partialPath, {
          paneKey: 'pk',
          launchToken: 'ltok-buffer',
          onEvent: (ev) => {
            seen.push(ev)
            bridge.stop()
            resolve()
          },
          onError: () => {}
        })
        setTimeout(() => {
          bridge.stop()
          resolve()
        }, 3000)
      })
      expect(seen).toHaveLength(1)
      expect(seen[0].hookEventName).toBe('run_complete')
      expect(seen[0].hookPayload).toEqual({ session_id: 's1', text: 'hi' })
    } finally {
      partialServer.close()
    }
  })

  it('survives an onEvent that throws (with a re-throwing onError) and keeps forwarding later events', async () => {
    // Why: regress here if the inner try/catch around deps.onError is removed —
    // a re-throwing onError would propagate out of `res.on('data')` and kill the
    // SSE read loop, dropping every subsequent event in the same stream.
    const doublePath = join(tmp, 'double.sock')
    const doubleServer = createServer((req, res) => {
      if (req.url !== '/v1/workspaces/0/events') {
        res.writeHead(404)
        res.end()
        return
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write(
        'data: {"type":"run_complete","payload":{"payload":{"session_id":"first","text":"a"}}}\n\n' +
          'data: {"type":"run_complete","payload":{"payload":{"session_id":"second","text":"b"}}}\n\n'
      )
    })
    doubleServer.listen(doublePath)
    try {
      const seen: { hookEventName: string; hookPayload: Record<string, unknown> }[] = []
      await new Promise<void>((resolve) => {
        let first = true
        const bridge = startCrushSseBridge(doublePath, {
          paneKey: 'pk',
          launchToken: 'ltok-guard',
          onEvent: (ev) => {
            if (first) {
              first = false
              throw new Error('boom')
            }
            seen.push(ev)
            bridge.stop()
            resolve()
          },
          onError: () => {
            throw new Error('onError-boom')
          }
        })
        setTimeout(() => {
          bridge.stop()
          resolve()
        }, 2000)
      })
      expect(seen).toHaveLength(1)
      expect(seen[0].hookPayload).toEqual({ session_id: 'second', text: 'b' })
    } finally {
      doubleServer.close()
    }
  })

  it('stop() is idempotent and halts reconnection', () => {
    const bridge = startCrushSseBridge(socketPath, {
      paneKey: 'pk',
      launchToken: 'ltok-2',
      onEvent: () => {}
    })
    bridge.stop()
    bridge.stop()
    expect(bridge.stopped()).toBe(true)
  })

  it('routes a connect failure (missing socket) to onError so the retry loop is observable', async () => {
    // Why: regress here if connection-level errors stop flowing through
    // deps.onError — a permanently wrong socket path would otherwise reconnect
    // forever with zero visibility from the runtime side.
    const badPath = join(tmp, 'does-not-exist.sock')
    const errors: Error[] = []
    await new Promise<void>((resolve) => {
      const bridge = startCrushSseBridge(badPath, {
        paneKey: 'pk',
        launchToken: 'ltok-bad',
        onEvent: () => {},
        onError: (err) => {
          errors.push(err)
          bridge.stop()
          resolve()
        }
      })
      setTimeout(() => {
        bridge.stop()
        resolve()
      }, 2000)
    })
    expect(errors.length).toBeGreaterThanOrEqual(1)
    expect(errors[0]).toBeInstanceOf(Error)
    expect(errors[0].message.length).toBeGreaterThan(0)
  })
})

// Keep http referenced for type-only integration tests in dev tooling.
void http
