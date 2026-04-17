import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { tmpdir } from 'os'
import { join } from 'path'
import { mkdtempSync, rmSync } from 'fs'
import { DaemonPtyProvider } from './daemon-pty-provider'
import { DaemonServer } from './daemon-server'
import type { SubprocessHandle } from './session'

function createTestDir(): string {
  return mkdtempSync(join(tmpdir(), 'daemon-provider-test-'))
}

function createMockSubprocess(): SubprocessHandle & {
  _simulateData: (data: string) => void
  _simulateExit: (code: number) => void
} {
  let onDataCb: ((data: string) => void) | null = null
  let onExitCb: ((code: number) => void) | null = null
  return {
    pid: 77777,
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(() => setTimeout(() => onExitCb?.(0), 5)),
    forceKill: vi.fn(),
    signal: vi.fn(),
    onData(cb) {
      onDataCb = cb
    },
    onExit(cb) {
      onExitCb = cb
    },
    _simulateData(data: string) {
      onDataCb?.(data)
    },
    _simulateExit(code: number) {
      onExitCb?.(code)
    }
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('waitFor timed out')
    }
    await new Promise((r) => setTimeout(r, 10))
  }
}

describe('DaemonPtyProvider', () => {
  let dir: string
  let socketPath: string
  let tokenPath: string
  let server: DaemonServer
  let provider: DaemonPtyProvider
  let lastSubprocess: ReturnType<typeof createMockSubprocess>

  beforeEach(async () => {
    dir = createTestDir()
    socketPath = join(dir, 'test.sock')
    tokenPath = join(dir, 'test.token')

    server = new DaemonServer({
      socketPath,
      tokenPath,
      spawnSubprocess: () => {
        lastSubprocess = createMockSubprocess()
        return lastSubprocess
      }
    })
    await server.start()

    provider = new DaemonPtyProvider({ socketPath, tokenPath })
  })

  afterEach(async () => {
    await provider?.cleanup()
    await server?.shutdown()
    rmSync(dir, { recursive: true, force: true })
  })

  describe('spawn', () => {
    it('creates a session in the daemon and returns an id', async () => {
      const result = await provider.spawn({
        cols: 80,
        rows: 24,
        sessionId: 'test-session'
      })

      expect(result.id).toBe('test-session')
    })

    it('spawns with cwd and env', async () => {
      const result = await provider.spawn({
        cols: 80,
        rows: 24,
        cwd: '/home/user',
        env: { MY_VAR: 'hello' },
        sessionId: 'session-with-env'
      })

      expect(result.id).toBe('session-with-env')
    })
  })

  describe('write', () => {
    it('sends data to the daemon session', async () => {
      await provider.spawn({ cols: 80, rows: 24, sessionId: 's1' })

      // Should not throw
      provider.write('s1', 'ls\n')

      // Give the fire-and-forget notify time to arrive
      await new Promise((r) => setTimeout(r, 50))
      expect(lastSubprocess.write).toHaveBeenCalledWith('ls\n')
    })
  })

  describe('resize', () => {
    it('resizes the daemon session', async () => {
      await provider.spawn({ cols: 80, rows: 24, sessionId: 's1' })
      provider.resize('s1', 120, 40)

      await new Promise((r) => setTimeout(r, 50))
      expect(lastSubprocess.resize).toHaveBeenCalledWith(120, 40)
    })
  })

  describe('shutdown (kill session)', () => {
    it('kills the session in the daemon', async () => {
      await provider.spawn({ cols: 80, rows: 24, sessionId: 's1' })
      await provider.shutdown('s1', false)

      expect(lastSubprocess.kill).toHaveBeenCalled()
    })
  })

  describe('data events', () => {
    it('delivers data events from the daemon to onData listeners', async () => {
      const dataPayloads: { id: string; data: string }[] = []
      provider.onData((payload) => dataPayloads.push(payload))

      await provider.spawn({ cols: 80, rows: 24, sessionId: 's1' })

      // Simulate PTY output from subprocess
      lastSubprocess._simulateData('hello from shell')

      await waitFor(() => dataPayloads.length > 0)
      expect(dataPayloads[0]).toEqual({ id: 's1', data: 'hello from shell' })
    })
  })

  describe('exit events', () => {
    it('delivers exit events from the daemon to onExit listeners', async () => {
      const exits: { id: string; code: number }[] = []
      provider.onExit((payload) => exits.push(payload))

      await provider.spawn({ cols: 80, rows: 24, sessionId: 's1' })

      lastSubprocess._simulateExit(42)

      await waitFor(() => exits.length > 0)
      expect(exits[0]).toEqual({ id: 's1', code: 42 })
    })
  })

  describe('cleanup', () => {
    it('disconnects from daemon without killing sessions', async () => {
      await provider.spawn({ cols: 80, rows: 24, sessionId: 's1' })
      await provider.cleanup()

      // Session should still be alive in the daemon — verify by connecting a new provider
      const provider2 = new DaemonPtyProvider({ socketPath, tokenPath })
      const result = await provider2.spawn({ cols: 80, rows: 24, sessionId: 's1' })

      // Should reattach (not create new) since the session is alive
      // The daemon's createOrAttach returns isNew=false for existing sessions
      expect(result.id).toBe('s1')
      await provider2.cleanup()
    })
  })

  describe('multiple sessions', () => {
    it('handles multiple concurrent sessions', async () => {
      const r1 = await provider.spawn({ cols: 80, rows: 24, sessionId: 'a' })
      const r2 = await provider.spawn({ cols: 80, rows: 24, sessionId: 'b' })
      const r3 = await provider.spawn({ cols: 80, rows: 24, sessionId: 'c' })

      expect(r1.id).toBe('a')
      expect(r2.id).toBe('b')
      expect(r3.id).toBe('c')
    })
  })
})
