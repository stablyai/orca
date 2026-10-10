import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import {
  DaemonSpawner,
  getDaemonArtifactHoldClaimPath,
  getDaemonPidPath,
  getDaemonPidSwapClaimPath,
  getDaemonSocketPath,
  getDaemonTokenPath,
  publishDaemonPidFile,
  replaceDaemonPidFile,
  restoreClaimedDaemonArtifact
} from './daemon-spawner'
import { getDaemonSocketBindPath } from './daemon-endpoint-ownership'
import { startDaemon, type DaemonHandle } from './daemon-main'
import { DaemonClient } from './client'
import type { SubprocessHandle } from './session-subprocess-handle'
import { PROTOCOL_VERSION } from './types'

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
    forceKill: vi.fn(() => setTimeout(() => onExitCb?.(137), 5)),
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
    it('passes the scoped PID path and a fresh launch nonce to the launcher', async () => {
      const launcher = vi.fn(async () => ({ shutdown: vi.fn(async () => {}) }))
      spawner = new DaemonSpawner({ runtimeDir: dir, launcher })

      await spawner.ensureRunning()

      expect(launcher).toHaveBeenCalledWith(
        getDaemonSocketPath(dir),
        getDaemonTokenPath(dir),
        getDaemonPidPath(dir),
        expect.stringMatching(/^[0-9a-f-]{36}$/)
      )
    })

    it('uses protocol-scoped socket and token paths', () => {
      const socketPath = getDaemonSocketPath(dir)
      const tokenPath = getDaemonTokenPath(dir)
      const pidPath = getDaemonPidPath(dir)

      if (process.platform === 'win32') {
        expect(socketPath).toContain(`orca-terminal-host-v${PROTOCOL_VERSION}`)
      } else {
        expect(socketPath).toBe(join(dir, `daemon-v${PROTOCOL_VERSION}.sock`))
      }
      expect(tokenPath).toBe(join(dir, `daemon-v${PROTOCOL_VERSION}.token`))
      expect(pidPath).toBe(join(dir, `daemon-v${PROTOCOL_VERSION}.pid`))
    })

    it('starts daemon and returns connection info', async () => {
      const s = createSpawner()
      const info = await s.ensureRunning()

      if (process.platform === 'win32') {
        expect(info.socketPath).toContain(`orca-terminal-host-v${PROTOCOL_VERSION}`)
      } else {
        expect(info.socketPath).toContain(dir)
      }
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

  it('allows claim cleanup after successful restore or a confirmed replacement', () => {
    expect(
      restoreClaimedDaemonArtifact('/claimed', '/canonical', {
        copyExclusive: () => {},
        canonicalExists: () => false
      })
    ).toBe(true)
    expect(
      restoreClaimedDaemonArtifact('/claimed', '/canonical', {
        copyExclusive: () => {
          throw Object.assign(new Error('injected EEXIST'), { code: 'EEXIST' })
        },
        canonicalExists: () => true
      })
    ).toBe(true)
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
    // A read-only parent denies the rename with EACCES, standing in for the Windows
    // AV/indexer lock that fails the claim on a record which is merely open.
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

describe('daemon socket publication', () => {
  it('keeps every scratch namespace outside the released sweeper pattern', () => {
    // Why pinned, and why all three: builds already in the field sweep these names on age alone
    // with no liveness or ownership check, and deleting our sweeper does not un-ship theirs. A
    // bind name is a live listener's only pathname; a claim briefly holds the only copy of a
    // live daemon's token or PID record. Renaming any of them back into the released pattern
    // must fail here rather than in the field.
    const RELEASED_SWEEPER_PATTERN =
      /(?:\.(?:cleanup|replace)-\d+-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|^\.b[0-9a-f]{10})$/

    for (let i = 0; i < 20; i++) {
      const names = [
        basename(getDaemonSocketBindPath(getDaemonSocketPath('/tmp/orca-daemon'))),
        basename(getDaemonPidSwapClaimPath('/tmp/orca-daemon/daemon-v32.pid')),
        basename(getDaemonArtifactHoldClaimPath('/tmp/orca-daemon/daemon-v32.token'))
      ]
      for (const name of names) {
        expect(name).not.toMatch(RELEASED_SWEEPER_PATTERN)
      }
    }
  })

  it('keeps the bind name shorter than the canonical endpoint', () => {
    // sockaddr_un caps the path, so the private bind name must never extend it.
    const canonicalPath = getDaemonSocketPath('/tmp/orca-daemon-runtime')

    expect(getDaemonSocketBindPath(canonicalPath).length).toBeLessThan(canonicalPath.length)
  })
})
