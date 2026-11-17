import '../../pty-subprocess/testing/mock-descendant-sweep'
import type { Socket } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DaemonClient } from '../../transport/client/daemon-client'
import { DaemonPtyAdapter } from '../../providers/adapter/daemon-pty-adapter'
import { DaemonServer } from '../daemon-server'
import { getDaemonPidPath, getDaemonSocketPath } from '../../launch/daemon-spawner'
import type { SubprocessHandle } from '../../sessions/session-subprocess-handle'

type ManualTimer = {
  callback: () => void
  dueAt: number
  cancelled: boolean
}

class ManualIdleClock {
  private nowMs = 0
  private timers = new Set<ManualTimer>()

  setTimeout(callback: () => void, delayMs: number): ManualTimer {
    const timer = { callback, dueAt: this.nowMs + delayMs, cancelled: false }
    this.timers.add(timer)
    return timer
  }

  clearTimeout(handle: unknown): void {
    const timer = handle as ManualTimer
    timer.cancelled = true
    this.timers.delete(timer)
  }

  now(): number {
    return this.nowMs
  }

  advanceBy(ms: number): void {
    this.nowMs += ms
    for (const timer of [...this.timers].sort((a, b) => a.dueAt - b.dueAt)) {
      if (timer.cancelled || timer.dueAt > this.nowMs) {
        continue
      }
      this.timers.delete(timer)
      timer.callback()
    }
  }

  get pendingCount(): number {
    return this.timers.size
  }
}
type DaemonServerInternals = {
  connections: {
    clients: Map<string, { controlSocket: Socket }>
    accept(socket: Socket): void
  }
  admission: { createOrAttachInFlight: number }
  lifecycle: {
    retirementRequested: boolean
    state: string
    beginIdleShutdown(): void
  }
  requestRouter: {
    route(clientId: string, request: unknown): Promise<unknown>
  }
  host: { dispose: () => Promise<void> }
}

function createMockSubprocess(): SubprocessHandle & { exit(code: number): void } {
  let onExit: ((code: number) => void) | null = null
  return {
    pid: 9345,
    getForegroundProcess: () => null,
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    terminateOwnedTree: () => 'unavailable' as const,
    forceKill: vi.fn(),
    signal: vi.fn(),
    onData: vi.fn(),
    onExit(callback) {
      onExit = callback
    },
    dispose: vi.fn(),
    exit(code) {
      onExit?.(code)
    }
  }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error('Timed out waiting for daemon idle state')
    }
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

describe('current daemon lifecycle retirement', () => {
  let dir: string
  let socketPath: string
  let tokenPath: string
  let pidPath: string
  let clock: ManualIdleClock
  let server: DaemonServer | null
  let subprocess: ReturnType<typeof createMockSubprocess>
  let onIdleShutdown: ReturnType<typeof vi.fn<() => void>>

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'daemon-idle-shutdown-'))
    socketPath = getDaemonSocketPath(dir)
    tokenPath = join(dir, 'daemon.token')
    pidPath = getDaemonPidPath(dir)
    clock = new ManualIdleClock()
    subprocess = createMockSubprocess()
    onIdleShutdown = vi.fn<() => void>()
    server = null
  })

  afterEach(async () => {
    await server?.shutdown().catch(() => {})
    rmSync(dir, { recursive: true, force: true })
  })

  async function startServer(
    options: {
      launchNonce?: string
      protocolVersion?: number
    } = {}
  ): Promise<void> {
    server = new DaemonServer({
      socketPath,
      tokenPath,
      ...(options.launchNonce ? { pidPath, launchNonce: options.launchNonce } : {}),
      ...(options.protocolVersion !== undefined
        ? { protocolVersion: options.protocolVersion }
        : {}),
      initialAdoptionTestConfig: { timeoutMs: 100, clock },
      onIdleShutdown,
      spawnSubprocess: () => subprocess
    })
    await server.start()
  }

  it('keeps resources alive until the shutdownIfIdle reply write flushes', async () => {
    await startServer()
    const client = new DaemonClient({ socketPath, tokenPath })
    await client.ensureConnected()
    const daemon = server as unknown as DaemonServerInternals
    const controlSocket = [...daemon.connections.clients.values()][0].controlSocket
    const originalWrite = controlSocket.write.bind(controlSocket)
    let replyFlushed: (() => void) | undefined
    vi.spyOn(controlSocket, 'write').mockImplementation(((
      chunk: string | Uint8Array,
      ...args: unknown[]
    ) => {
      replyFlushed = args.find((arg) => typeof arg === 'function') as (() => void) | undefined
      return originalWrite(chunk)
    }) as unknown as Socket['write'])
    const dispose = vi.spyOn(daemon.host, 'dispose')

    await expect(client.request('shutdownIfIdle', undefined)).resolves.toEqual({ retiring: true })
    expect(dispose).not.toHaveBeenCalled()
    expect(onIdleShutdown).not.toHaveBeenCalled()

    replyFlushed?.()
    await waitFor(() => onIdleShutdown.mock.calls.length === 1)
    expect(dispose).toHaveBeenCalledOnce()
    client.disconnect()
  })

  it('reopens adapter admission when the daemon refuses retirement for a live session', async () => {
    await startServer()
    const adapter = new DaemonPtyAdapter({ socketPath, tokenPath })
    await adapter.spawn({ sessionId: 'already-live', cols: 80, rows: 24 })

    await expect(adapter.requestIdleRetirement()).resolves.toEqual({
      state: 'busy',
      liveSessions: 1,
      admissionReopened: true
    })
    const alreadyLiveSubprocess = subprocess
    subprocess = createMockSubprocess()
    await expect(
      adapter.spawn({ sessionId: 'allowed-after-refusal', cols: 80, rows: 24 })
    ).resolves.toMatchObject({ id: 'allowed-after-refusal' })
    expect(onIdleShutdown).not.toHaveBeenCalled()
    alreadyLiveSubprocess.exit(0)
    subprocess.exit(0)
    adapter.dispose()
  })
})
