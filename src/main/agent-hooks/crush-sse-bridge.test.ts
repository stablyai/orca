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
  startCrushSseBridge
} from './crush-sse-bridge'
import { crushOrcaSocketFileName } from '../../shared/crush-sse-shapes'

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

describe('crushSseBridgeSupported', () => {
  it('matches the current process platform (no NaN-style universal assertions)', () => {
    const supported = crushSseBridgeSupported()
    expect(supported).toBe(process.platform === 'darwin' || process.platform === 'linux')
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
})

// Keep http referenced for type-only integration tests in dev tooling.
void http
