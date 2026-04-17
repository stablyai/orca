import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { tmpdir } from 'os'
import { join } from 'path'
import { mkdtempSync, rmSync } from 'fs'
import { DaemonSpawner, getDaemonSocketPath, getDaemonTokenPath } from './daemon-spawner'
import { startDaemon, type DaemonHandle } from './daemon-main'
import { DaemonClient } from './client'
import type { SubprocessHandle } from './session'
import { PROTOCOL_VERSION } from './types'

function createTestDir(): string {
  return mkdtempSync(join(tmpdir(), 'daemon-spawner-test-'))
}

function createMockSubprocess(): SubprocessHandle {
  let onExitCb: ((code: number) => void) | null = null
  return {
    pid: 88888,
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(() => setTimeout(() => onExitCb?.(0), 5)),
    forceKill: vi.fn(),
    signal: vi.fn(),
    onData(_cb: (data: string) => void) {},
    onExit(cb: (code: number) => void) {
      onExitCb = cb
    }
  }
}

describe('DaemonSpawner', () => {
  let dir: string
  let spawner: DaemonSpawner
  let activeDaemons: DaemonHandle[]

  beforeEach(() => {
    dir = createTestDir()
    activeDaemons = []
  })

  afterEach(async () => {
    await spawner?.shutdown()
    for (const d of activeDaemons) {
      await d.shutdown().catch(() => {})
    }
    rmSync(dir, { recursive: true, force: true })
  })

  function createSpawner(): DaemonSpawner {
    spawner = new DaemonSpawner({
      runtimeDir: dir,
      launcher: async (socketPath, tokenPath) => {
        const handle = await startDaemon({
          socketPath,
          tokenPath,
          spawnSubprocess: () => createMockSubprocess()
        })
        activeDaemons.push(handle)
        return { shutdown: () => handle.shutdown() }
      }
    })
    return spawner
  }

  describe('ensureRunning', () => {
    it('uses protocol-scoped socket and token paths', () => {
      const socketPath = getDaemonSocketPath(dir)
      const tokenPath = getDaemonTokenPath(dir)

      if (process.platform === 'win32') {
        expect(socketPath).toContain(`orca-terminal-host-v${PROTOCOL_VERSION}`)
      } else {
        expect(socketPath).toBe(join(dir, `daemon-v${PROTOCOL_VERSION}.sock`))
      }
      expect(tokenPath).toBe(join(dir, `daemon-v${PROTOCOL_VERSION}.token`))
    })

    it('starts daemon and returns connection info', async () => {
      const s = createSpawner()
      const info = await s.ensureRunning()

      expect(info.socketPath).toContain(dir)
      expect(info.tokenPath).toContain(dir)
    })

    it('returns same info on subsequent calls', async () => {
      const s = createSpawner()
      const info1 = await s.ensureRunning()
      const info2 = await s.ensureRunning()

      expect(info1.socketPath).toBe(info2.socketPath)
      expect(info1.tokenPath).toBe(info2.tokenPath)
    })

    it('daemon is connectable after ensureRunning', async () => {
      const s = createSpawner()
      const info = await s.ensureRunning()

      const client = new DaemonClient({
        socketPath: info.socketPath,
        tokenPath: info.tokenPath
      })
      await client.ensureConnected()
      expect(client.isConnected()).toBe(true)
      client.disconnect()
    })

    it('daemon can create sessions', async () => {
      const s = createSpawner()
      const info = await s.ensureRunning()

      const client = new DaemonClient({
        socketPath: info.socketPath,
        tokenPath: info.tokenPath
      })
      await client.ensureConnected()

      const result = await client.request<{ isNew: boolean }>('createOrAttach', {
        sessionId: 'test-session',
        cols: 80,
        rows: 24
      })
      expect(result.isNew).toBe(true)
      client.disconnect()
    })
  })

  describe('shutdown', () => {
    it('stops the daemon', async () => {
      const s = createSpawner()
      const info = await s.ensureRunning()
      await s.shutdown()

      const client = new DaemonClient({
        socketPath: info.socketPath,
        tokenPath: info.tokenPath
      })
      await expect(client.ensureConnected()).rejects.toThrow()
    })

    it('can be called when daemon is not running', async () => {
      const s = createSpawner()
      await expect(s.shutdown()).resolves.toBeUndefined()
    })

    it('allows re-start after shutdown', async () => {
      const s = createSpawner()
      await s.ensureRunning()
      await s.shutdown()

      const info = await s.ensureRunning()
      const client = new DaemonClient({
        socketPath: info.socketPath,
        tokenPath: info.tokenPath
      })
      await client.ensureConnected()
      expect(client.isConnected()).toBe(true)
      client.disconnect()
    })
  })
})
