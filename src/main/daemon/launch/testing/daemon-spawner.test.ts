import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import {
  DaemonSpawner,
  publishDaemonPidFile,
  replaceDaemonPidFile,
  restoreClaimedDaemonArtifact
} from '../daemon-spawner'
import { startDaemon, type DaemonHandle } from '../../server/daemon-main'
import { DaemonClient } from '../../transport/client/daemon-client'
import type { SubprocessHandle } from '../../sessions/session-subprocess-handle'

function createTestDir(): string {
  return mkdtempSync(join(tmpdir(), 'daemon-spawner-test-'))
}

function createMockSubprocess(): SubprocessHandle {
  let onExitCb: ((code: number) => void) | null = null
  return {
    pid: 88888,
    getForegroundProcess: vi.fn(() => null),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(() => setTimeout(() => onExitCb?.(0), 5)),
    terminateOwnedTree: () => 'unavailable' as const,
    forceKill: vi.fn(() => {
      setTimeout(() => onExitCb?.(137), 5)
    }),
    signal: vi.fn(),
    onData(_cb: (data: string) => void) {},
    onExit(cb: (code: number) => void) {
      onExitCb = cb
    },
    dispose: vi.fn()
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

describe('restoreClaimedDaemonArtifact', () => {
  it('retains the unique claim when restoration fails without a replacement', () => {
    expect(
      restoreClaimedDaemonArtifact('/claimed', '/canonical', {
        copyExclusive: () => {
          throw new Error('injected ENOSPC')
        },
        canonicalExists: () => false
      })
    ).toBe(false)
  })

  it('retains the unique claim when a failed copy leaves a partial canonical file', () => {
    const restoreDir = createTestDir()
    const canonicalPath = join(restoreDir, 'partial-canonical')
    try {
      expect(
        restoreClaimedDaemonArtifact('/claimed', canonicalPath, {
          copyExclusive: () => {
            writeFileSync(canonicalPath, 'partial')
            throw Object.assign(new Error('injected ENOSPC'), { code: 'ENOSPC' })
          },
          canonicalExists: () => true
        })
      ).toBe(false)
    } finally {
      rmSync(restoreDir, { recursive: true, force: true })
    }
  })
})

describe('daemon PID publication', () => {
  it('publishes ownership exclusively', () => {
    const dir = createTestDir()
    const pidPath = join(dir, 'daemon.pid')
    try {
      publishDaemonPidFile(pidPath, {
        pid: 101,
        startedAtMs: 1_000,
        launchNonce: 'launch-a'
      })

      expect(() =>
        publishDaemonPidFile(pidPath, {
          pid: 202,
          startedAtMs: 2_000,
          launchNonce: 'launch-b'
        })
      ).toThrow()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('atomically replaces stale ownership with the authenticated endpoint identity', () => {
    const dir = createTestDir()
    const pidPath = join(dir, 'daemon.pid')
    const endpointIdentity = {
      pid: 202,
      startedAtMs: 2_000,
      launchNonce: 'launch-b'
    }
    try {
      writeFileSync(pidPath, '{"pid":101,"launchNonce":"launch-a"}')

      expect(replaceDaemonPidFile(pidPath, endpointIdentity)).toBe(true)
      expect(JSON.parse(readFileSync(pidPath, 'utf8'))).toEqual(endpointIdentity)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reports failure and preserves the record when the rename claim fails for any reason but absence', () => {
    // POSIX directory permissions model the rename failure caused by Windows file locks.
    if (process.platform === 'win32' || process.getuid?.() === 0) {
      return
    }
    const dir = createTestDir()
    const pidPath = join(dir, 'daemon.pid')
    const existingRecord = '{"pid":101,"launchNonce":"launch-a"}'
    writeFileSync(pidPath, existingRecord)
    try {
      chmodSync(dir, 0o500)

      expect(
        replaceDaemonPidFile(pidPath, { pid: 202, startedAtMs: 2_000, launchNonce: 'launch-b' })
      ).toBe(false)
      expect(readFileSync(pidPath, 'utf8')).toBe(existingRecord)
    } finally {
      chmodSync(dir, 0o700)
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
