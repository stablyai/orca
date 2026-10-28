import './mock-descendant-sweep'
// Degraded fallback requires protocol replies; stalled health or hello RPCs remain unreachable.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { DaemonServer } from './daemon-server'
import { checkDaemonHealth } from './daemon-health'
import { createNdjsonParser } from './ndjson'
import type { SubprocessHandle } from './session-subprocess-handle'

const scheduleHealthEntryTimeout = setTimeout
const cancelHealthEntryTimeout = clearTimeout

async function waitForHealthEntry<T>(entry: Promise<T>, health: Promise<unknown>): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  let healthSettled = false
  const earlySettlement = health.then(
    () => {
      healthSettled = true
      throw new Error('Daemon health settled before its required socket/RPC entry')
    },
    (error) => {
      healthSettled = true
      throw error
    }
  )
  const entryBudget = new Promise<never>((_resolve, reject) => {
    timeout = scheduleHealthEntryTimeout(
      () => reject(new Error('Daemon health socket/RPC entry exceeded its real 3000ms budget')),
      3_000
    )
  })
  try {
    return await Promise.race([entry, earlySettlement, entryBudget])
  } catch (error) {
    // Let the real health owner close its socket before server teardown.
    if (!healthSettled) {
      await vi.advanceTimersByTimeAsync(3_000)
    }
    throw error
  } finally {
    cancelHealthEntryTimeout(timeout)
  }
}

function createMockSubprocess(): SubprocessHandle {
  return {
    pid: 55555,
    getForegroundProcess: () => null,
    write() {},
    resize() {},
    kill() {},
    terminateOwnedTree: () => 'unavailable' as const,
    forceKill() {},
    signal() {},
    onData() {},
    onExit() {},
    dispose() {}
  }
}

function daemonTestSocketPath(dir: string): string {
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\${basename(dir)}-daemon.sock`
    : join(dir, 'daemon.sock')
}

describe('issue #6814 repro: daemon failure-mode classification', () => {
  let dir: string
  let socketPath: string
  let tokenPath: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'issue-6814-repro-'))
    socketPath = daemonTestSocketPath(dir)
    tokenPath = join(dir, 'daemon.token')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('WEDGED: a daemon whose health RPC never resolves classifies as unreachable (NOT degraded)', async () => {
    let resolveHealthEntered = (): void => {}
    const healthEntered = new Promise<void>((resolve) => {
      resolveHealthEntered = resolve
    })
    const server = new DaemonServer({
      socketPath,
      tokenPath,
      // Model a stalled health RPC without blocking the test process’s event loop.
      ptySpawnHealthCheck: vi.fn(() => {
        resolveHealthEntered()
        return new Promise<void>(() => {})
      }),
      spawnSubprocess: () => createMockSubprocess()
    })
    await server.start()
    try {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldClearNativeTimers: true })
      const pendingHealth = checkDaemonHealth(socketPath, tokenPath)
      let settled = false
      void pendingHealth.then(
        () => {
          settled = true
        },
        () => {
          settled = true
        }
      )
      await waitForHealthEntry(healthEntered, pendingHealth)
      await vi.advanceTimersByTimeAsync(2_999)
      expect(settled).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      const health = await pendingHealth
      expect(health).toBe('unreachable')
    } finally {
      vi.useRealTimers()
      await server.shutdown()
    }
  }, 15000)

  it('WEDGED-HELLO: a daemon that accepts connections but never answers hello classifies as unreachable (#8689)', async () => {
    let resolveHello: (message: unknown) => void = () => {}
    const helloReceived = new Promise<unknown>((resolve) => {
      resolveHello = resolve
    })
    const wedged = createServer((sock) => {
      const parser = createNdjsonParser(resolveHello)
      sock.on('data', (chunk) => parser.feed(chunk.toString()))
    })
    await new Promise<void>((resolve) => wedged.listen(socketPath, () => resolve()))
    // The health check authenticates from the token file before connecting.
    writeFileSync(tokenPath, 'wedged-token')
    try {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldClearNativeTimers: true })
      const pendingHealth = checkDaemonHealth(socketPath, tokenPath)
      let settled = false
      void pendingHealth.then(
        () => {
          settled = true
        },
        () => {
          settled = true
        }
      )
      expect(await waitForHealthEntry(helloReceived, pendingHealth)).toMatchObject({
        type: 'hello',
        token: 'wedged-token',
        clientId: 'health-check',
        role: 'control'
      })
      await vi.advanceTimersByTimeAsync(2_999)
      expect(settled).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      const health = await pendingHealth
      expect(health).toBe('unreachable')
    } finally {
      vi.useRealTimers()
      await new Promise<void>((resolve) => wedged.close(() => resolve()))
    }
  }, 15000)
})
