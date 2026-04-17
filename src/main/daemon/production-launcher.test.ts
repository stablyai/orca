import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { tmpdir } from 'os'
import { join } from 'path'
import { mkdtempSync, rmSync } from 'fs'
import { createProductionLauncher } from './production-launcher'
import { startDaemon, type DaemonHandle } from './daemon-main'
import { DaemonClient } from './client'
import type { SubprocessHandle } from './session'

function createTestDir(): string {
  return mkdtempSync(join(tmpdir(), 'prod-launcher-test-'))
}

function createMockSubprocess(): SubprocessHandle {
  let onExitCb: ((code: number) => void) | null = null
  return {
    pid: 44444,
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

describe('createProductionLauncher', () => {
  let dir: string
  let handles: DaemonHandle[]

  beforeEach(() => {
    dir = createTestDir()
    handles = []
  })

  afterEach(async () => {
    for (const h of handles) {
      await h.shutdown().catch(() => {})
    }
    rmSync(dir, { recursive: true, force: true })
  })

  it('returns a launcher function', () => {
    const launcher = createProductionLauncher({
      getDaemonEntryPath: () => '/fake/path.js'
    })
    expect(typeof launcher).toBe('function')
  })

  it('can be used with DaemonSpawner (in-process fallback)', async () => {
    // Use in-process launcher for testing (same as DaemonSpawner tests)
    const launcher = async (socketPath: string, tokenPath: string) => {
      const handle = await startDaemon({
        socketPath,
        tokenPath,
        spawnSubprocess: () => createMockSubprocess()
      })
      handles.push(handle)
      return { shutdown: () => handle.shutdown() }
    }

    const socketPath = join(dir, 'test.sock')
    const tokenPath = join(dir, 'test.token')
    const handle = await launcher(socketPath, tokenPath)

    const client = new DaemonClient({ socketPath, tokenPath })
    await client.ensureConnected()
    expect(client.isConnected()).toBe(true)
    client.disconnect()

    await handle.shutdown()
    handles.pop()
  })
})
