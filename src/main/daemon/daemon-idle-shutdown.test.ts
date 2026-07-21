import { EventEmitter } from 'node:events'
import { connect, type Socket } from 'node:net'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DaemonClient } from './client'
import { DaemonPtyAdapter } from './daemon-pty-adapter'
import { DaemonServer } from './daemon-server'
import { PROTOCOL_VERSION } from './types'
import {
  getDaemonPidPath,
  getDaemonSocketPath,
  serializeDaemonPidFile,
  unlinkOwnedDaemonPidFile
} from './daemon-spawner'
import type { SubprocessHandle } from './session'

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

function createMockSubprocess(): SubprocessHandle & { exit(code: number): void } {
  let onExit: ((code: number) => void) | null = null
  return {
    pid: 9345,
    getForegroundProcess: () => null,
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
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

async function requestOnRawSocket(
  socket: Socket,
  request: { id: string; type: string; payload: unknown }
): Promise<{ error?: string }> {
  return new Promise((resolve, reject) => {
    let buffer = ''
    const cleanup = (): void => {
      clearTimeout(timeout)
      socket.off('data', onData)
    }
    const onData = (chunk: Buffer): void => {
      buffer += chunk.toString('utf8')
      for (;;) {
        const newlineIndex = buffer.indexOf('\n')
        if (newlineIndex === -1) {
          return
        }
        const line = buffer.slice(0, newlineIndex)
        buffer = buffer.slice(newlineIndex + 1)
        const message = JSON.parse(line) as { id?: string; error?: string }
        if (message.id === request.id) {
          cleanup()
          resolve(message)
          return
        }
      }
    }
    const timeout = setTimeout(() => {
      cleanup()
      reject(new Error(`Timed out waiting for raw response ${request.id}`))
    }, 2_000)
    socket.on('data', onData)
    socket.write(`${JSON.stringify(request)}\n`)
  })
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

  it('retires immediately after an unexpected empty disconnect and removes owned artifacts', async () => {
    const launchNonce = 'launch-a'
    writeFileSync(
      pidPath,
      serializeDaemonPidFile({ pid: process.pid, startedAtMs: null, launchNonce })
    )
    await startServer({ launchNonce })
    const client = new DaemonClient({ socketPath, tokenPath })
    await client.ensureConnected()
    client.disconnect()
    await waitFor(() => onIdleShutdown.mock.calls.length === 1)

    expect(clock.pendingCount).toBe(0)
    expect(existsSync(tokenPath)).toBe(false)
    expect(existsSync(pidPath)).toBe(false)
    if (process.platform !== 'win32') {
      expect(existsSync(socketPath)).toBe(false)
    }
  })

  it('retires a fresh daemon that is never adopted by a full client pair', async () => {
    await startServer()

    expect(clock.pendingCount).toBe(1)
    clock.advanceBy(100)

    await waitFor(() => onIdleShutdown.mock.calls.length === 1)
  })

  it('retires immediately after an authenticated clean disconnect proves it is empty', async () => {
    await startServer()
    const client = new DaemonClient({ socketPath, tokenPath })
    await client.ensureConnected()

    await expect(client.request('shutdownIfIdle', undefined)).resolves.toEqual({
      retiring: true
    })
    client.disconnect()

    await waitFor(() => onIdleShutdown.mock.calls.length === 1)
    expect(clock.pendingCount).toBe(0)
  })

  it('keeps resources alive until the shutdownIfIdle reply write flushes', async () => {
    await startServer()
    const client = new DaemonClient({ socketPath, tokenPath })
    await client.ensureConnected()
    const daemon = server as unknown as {
      clients: Map<string, { controlSocket: Socket }>
      host: { dispose: () => Promise<void> }
    }
    const controlSocket = [...daemon.clients.values()][0].controlSocket
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

  it('finishes shutdownIfIdle when the peer closes before its reply callback', async () => {
    await startServer()
    const client = new DaemonClient({ socketPath, tokenPath })
    await client.ensureConnected()
    const daemon = server as unknown as {
      clients: Map<string, { controlSocket: Socket }>
      host: { dispose: () => Promise<void> }
    }
    const controlSocket = [...daemon.clients.values()][0].controlSocket
    const originalWrite = controlSocket.write.bind(controlSocket)
    vi.spyOn(controlSocket, 'write').mockImplementation(((chunk: string | Uint8Array) =>
      originalWrite(chunk)) as unknown as Socket['write'])
    const dispose = vi.spyOn(daemon.host, 'dispose')

    await expect(client.request('shutdownIfIdle', undefined)).resolves.toEqual({ retiring: true })
    expect(dispose).not.toHaveBeenCalled()
    client.disconnect()

    await waitFor(() => onIdleShutdown.mock.calls.length === 1)
    expect(dispose).toHaveBeenCalledOnce()
  })

  it('connects and retires a never-used adapter during clean disconnect', async () => {
    await startServer()
    const adapter = new DaemonPtyAdapter({ socketPath, tokenPath })

    await adapter.disconnectOnly()

    await waitFor(() => onIdleShutdown.mock.calls.length === 1)
    expect(clock.pendingCount).toBe(0)
  })

  it('preserves a live session after clean detach and retires when that session exits', async () => {
    await startServer()
    const client = new DaemonClient({ socketPath, tokenPath })
    await client.ensureConnected()
    await client.request('createOrAttach', { sessionId: 'preserved', cols: 80, rows: 24 })

    await expect(client.request('shutdownIfIdle', undefined)).resolves.toEqual({
      retiring: false
    })
    client.disconnect()
    expect(onIdleShutdown).not.toHaveBeenCalled()
    subprocess.exit(0)

    await waitFor(() => onIdleShutdown.mock.calls.length === 1)
    expect(clock.pendingCount).toBe(0)
  })

  it('rejects clean retirement while create or attach is in flight', async () => {
    await startServer()
    const client = new DaemonClient({ socketPath, tokenPath })
    await client.ensureConnected()
    const daemon = server as unknown as { createOrAttachInFlight: number }
    daemon.createOrAttachInFlight = 1

    await expect(client.request('shutdownIfIdle', undefined)).resolves.toEqual({
      retiring: false
    })

    expect(onIdleShutdown).not.toHaveBeenCalled()
    client.disconnect()
  })

  it('rejects clean retirement when an unknown transport is connected', async () => {
    await startServer()
    const client = new DaemonClient({ socketPath, tokenPath })
    await client.ensureConnected()
    const rawSocket = connect(socketPath)
    await new Promise<void>((resolve) => rawSocket.once('connect', resolve))

    await expect(client.request('shutdownIfIdle', undefined)).resolves.toEqual({
      retiring: false
    })
    rawSocket.destroy()
    expect(onIdleShutdown).not.toHaveBeenCalled()
    client.disconnect()
  })

  it('rejects clean retirement while another authenticated client is connected', async () => {
    await startServer()
    const first = new DaemonClient({ socketPath, tokenPath })
    const second = new DaemonClient({ socketPath, tokenPath })
    await Promise.all([first.ensureConnected(), second.ensureConnected()])

    await expect(first.request('shutdownIfIdle', undefined)).resolves.toEqual({
      retiring: false
    })

    expect(onIdleShutdown).not.toHaveBeenCalled()
    first.disconnect()
    second.disconnect()
  })

  it("preserves another client's live session when failed adoption disconnects", async () => {
    await startServer()
    const adoptingAdapter = new DaemonPtyAdapter({ socketPath, tokenPath })
    const liveOwner = new DaemonClient({ socketPath, tokenPath })
    await Promise.all([adoptingAdapter.establishLifecycleLease(), liveOwner.ensureConnected()])
    await liveOwner.request('createOrAttach', {
      sessionId: 'owned-by-second-client',
      cols: 80,
      rows: 24
    })

    await adoptingAdapter.disconnectOnly()

    expect(onIdleShutdown).not.toHaveBeenCalled()
    await expect(liveOwner.request('listSessions', undefined)).resolves.toMatchObject({
      sessions: [expect.objectContaining({ sessionId: 'owned-by-second-client', isAlive: true })]
    })
    subprocess.exit(0)
    liveOwner.disconnect()
  })

  it('lets an overlapping raw socket block but not erase empty retirement', async () => {
    await startServer()
    const client = new DaemonClient({ socketPath, tokenPath })
    await client.ensureConnected()
    const rawSocket = connect(socketPath)
    await new Promise<void>((resolve) => rawSocket.once('connect', resolve))
    client.disconnect()

    expect(onIdleShutdown).not.toHaveBeenCalled()

    rawSocket.destroy()
    await waitFor(() => onIdleShutdown.mock.calls.length === 1)
    expect(clock.pendingCount).toBe(0)
  })

  it('retires after the last authenticated client disconnects with no sessions', async () => {
    await startServer()
    const client = new DaemonClient({ socketPath, tokenPath })
    await client.ensureConnected()
    expect(clock.pendingCount).toBe(0)

    client.disconnect()
    await waitFor(() => onIdleShutdown.mock.calls.length === 1)
    expect(clock.pendingCount).toBe(0)
  })

  it('lets a complete reconnect cancel retirement while a live session blocks it', async () => {
    await startServer()
    const first = new DaemonClient({ socketPath, tokenPath })
    await first.ensureConnected()
    await first.request('createOrAttach', { sessionId: 'reconnected', cols: 80, rows: 24 })
    first.disconnect()
    const daemon = server as unknown as { retirementRequested: boolean }
    await waitFor(() => daemon.retirementRequested)
    expect(onIdleShutdown).not.toHaveBeenCalled()

    const second = new DaemonClient({ socketPath, tokenPath })
    await second.ensureConnected()
    await waitFor(() => !daemon.retirementRequested)
    subprocess.exit(0)
    expect(onIdleShutdown).not.toHaveBeenCalled()

    second.disconnect()
    await waitFor(() => onIdleShutdown.mock.calls.length === 1)
  })

  it('cancels the initial-adoption timeout before the adapter creates its first terminal', async () => {
    await startServer()
    await waitFor(() => clock.pendingCount === 1)
    clock.advanceBy(50)

    const adopted = new DaemonPtyAdapter({ socketPath, tokenPath })
    await adopted.establishLifecycleLease()
    expect(clock.pendingCount).toBe(0)

    clock.advanceBy(100)
    expect(onIdleShutdown).not.toHaveBeenCalled()
    await expect(
      adopted.spawn({
        sessionId: 'first-after-adoption',
        cols: 80,
        rows: 24
      })
    ).resolves.toMatchObject({ id: 'first-after-adoption' })
    subprocess.exit(0)
    adopted.dispose()
  })

  it('does not let repeated authenticated control probes extend the startup deadline', async () => {
    await startServer()
    const healthControl = connect(socketPath)
    await new Promise<void>((resolve) => healthControl.once('connect', resolve))
    healthControl.write(
      `${JSON.stringify({
        type: 'hello',
        version: PROTOCOL_VERSION,
        token: readFileSync(tokenPath, 'utf8').trim(),
        clientId: 'startup-health-control',
        role: 'control'
      })}\n`
    )
    const daemon = server as unknown as { clients: Map<string, unknown> }
    await waitFor(() => daemon.clients.has('startup-health-control'))
    clock.advanceBy(1_000)
    healthControl.destroy()

    await waitFor(() => onIdleShutdown.mock.calls.length === 1)
  })

  it('does not let a control-only create cancel the initial-adoption timeout', async () => {
    await startServer()
    const control = connect(socketPath)
    await new Promise<void>((resolve) => control.once('connect', resolve))
    control.write(
      `${JSON.stringify({
        type: 'hello',
        version: PROTOCOL_VERSION,
        token: readFileSync(tokenPath, 'utf8').trim(),
        clientId: 'startup-control-create',
        role: 'control'
      })}\n`
    )
    const daemon = server as unknown as {
      clients: Map<string, unknown>
      retirementRequested: boolean
    }
    await waitFor(() => daemon.clients.has('startup-control-create'))
    const response = await requestOnRawSocket(control, {
      id: 'control-only-create',
      type: 'createOrAttach',
      payload: { sessionId: 'must-not-start', cols: 80, rows: 24 }
    })
    expect(response.error).toContain('connection is incomplete')
    expect(daemon.retirementRequested).toBe(false)
    expect(clock.pendingCount).toBe(0)

    clock.advanceBy(1_000)
    expect(onIdleShutdown).not.toHaveBeenCalled()

    control.destroy()
    await waitFor(() => onIdleShutdown.mock.calls.length === 1)
  })

  it('keeps empty-retirement intent when a control-only client overlaps the last app', async () => {
    await startServer()
    const paired = new DaemonClient({ socketPath, tokenPath })
    await paired.ensureConnected()
    const incomplete = connect(socketPath)
    await new Promise<void>((resolve) => incomplete.once('connect', resolve))
    incomplete.write(
      `${JSON.stringify({
        type: 'hello',
        version: PROTOCOL_VERSION,
        token: readFileSync(tokenPath, 'utf8').trim(),
        clientId: 'control-only-overlap',
        role: 'control'
      })}\n`
    )
    const daemon = server as unknown as {
      clients: Map<string, unknown>
      retirementRequested: boolean
    }
    await waitFor(() => daemon.clients.has('control-only-overlap'))

    paired.disconnect()
    await waitFor(() => daemon.retirementRequested)
    expect(clock.pendingCount).toBe(0)
    const response = await requestOnRawSocket(incomplete, {
      id: 'overlap-control-create',
      type: 'createOrAttach',
      payload: { sessionId: 'must-not-start', cols: 80, rows: 24 }
    })
    expect(response.error).toContain('connection is incomplete')
    expect(daemon.retirementRequested).toBe(true)

    incomplete.destroy()
    await waitFor(() => onIdleShutdown.mock.calls.length === 1)
  })

  it('keeps retirement intent when a same-client replacement never completes its stream', async () => {
    await startServer()
    const paired = new DaemonClient({ socketPath, tokenPath })
    await paired.ensureConnected()
    const clientId = (paired as unknown as { clientId: string }).clientId
    const replacementControl = connect(socketPath)
    await new Promise<void>((resolve) => replacementControl.once('connect', resolve))
    replacementControl.write(
      `${JSON.stringify({
        type: 'hello',
        version: PROTOCOL_VERSION,
        token: readFileSync(tokenPath, 'utf8').trim(),
        clientId,
        role: 'control'
      })}\n`
    )
    const daemon = server as unknown as {
      retirementRequested: boolean
    }
    await waitFor(() => daemon.retirementRequested)
    expect(clock.pendingCount).toBe(0)

    replacementControl.destroy()
    await waitFor(() => onIdleShutdown.mock.calls.length === 1)
  })

  it('keeps a live session after clients disconnect, then retires on its exit', async () => {
    await startServer()
    const client = new DaemonClient({ socketPath, tokenPath })
    await client.ensureConnected()
    await client.request('createOrAttach', { sessionId: 'live', cols: 80, rows: 24 })
    client.disconnect()
    const daemon = server as unknown as { retirementRequested: boolean }
    await waitFor(() => daemon.retirementRequested)

    expect(onIdleShutdown).not.toHaveBeenCalled()
    expect(clock.pendingCount).toBe(0)

    subprocess.exit(0)
    await waitFor(() => onIdleShutdown.mock.calls.length === 1)
  })

  it('uses the direct-construction protocol fixture version for hello compatibility', async () => {
    await startServer({ protocolVersion: 22 })
    const client = new DaemonClient({ socketPath, tokenPath, protocolVersion: 22 })

    await expect(client.ensureConnected()).resolves.toBeUndefined()
    client.disconnect()
  })

  it('requests clean retirement only for protocol v24 and newer adapters', async () => {
    await startServer()
    const current = new DaemonPtyAdapter({ socketPath, tokenPath })
    await current.listProcesses()
    const currentClient = (
      current as unknown as {
        client: DaemonClient
      }
    ).client
    const currentRequest = vi.spyOn(currentClient, 'request')

    await current.disconnectOnly()

    expect(currentRequest).toHaveBeenCalledOnce()
    expect(currentRequest.mock.calls[0]?.slice(0, 2)).toEqual(['shutdownIfIdle', undefined])
    const timeoutMs = currentRequest.mock.calls[0]?.[2]
    // Why: connection and RPC share a wall-clock budget, so elapsed setup time is expected.
    expect(timeoutMs).toEqual(expect.any(Number))
    expect(timeoutMs).toBeGreaterThan(0)
    expect(timeoutMs).toBeLessThanOrEqual(250)
  })

  it('does not send the v24 clean-disconnect RPC to a legacy daemon', async () => {
    await startServer({ protocolVersion: 23 })
    const legacy = new DaemonPtyAdapter({ socketPath, tokenPath, protocolVersion: 23 })
    await legacy.listProcesses()
    const legacyClient = (
      legacy as unknown as {
        client: DaemonClient
      }
    ).client
    const legacyRequest = vi.spyOn(legacyClient, 'request')

    await legacy.disconnectOnly()

    expect(legacyRequest.mock.calls.map(([type]) => type)).not.toContain('shutdownIfIdle')
  })

  it('rejects create or attach once the idle admission fence is pending', async () => {
    await startServer()
    const daemon = server as unknown as {
      idleShutdownState: string
      routeRequest(clientId: string, request: unknown): Promise<unknown>
    }
    daemon.idleShutdownState = 'idle-shutdown-pending'

    await expect(
      daemon.routeRequest('late-client', {
        id: 'late-create',
        type: 'createOrAttach',
        payload: { sessionId: 'late', cols: 80, rows: 24 }
      })
    ).rejects.toThrow('temporarily unavailable; reconnect')
  })

  it('aborts the pending shutdown when create or attach started before the fence', async () => {
    await startServer()
    const daemon = server as unknown as {
      createOrAttachInFlight: number
      idleShutdownState: string
      beginIdleShutdown(): void
    }
    daemon.createOrAttachInFlight = 1

    daemon.beginIdleShutdown()

    expect(daemon.idleShutdownState).toBe('running')
    expect(onIdleShutdown).not.toHaveBeenCalled()
  })

  it('explicitly marks a post-fence accepted transport as retryable', async () => {
    await startServer()
    const daemon = server as unknown as {
      idleShutdownState: string
      handleConnection(socket: Socket): void
    }
    daemon.idleShutdownState = 'idle-shutdown-pending'
    const socket = new EventEmitter() as Socket
    socket.end = vi.fn() as unknown as Socket['end']

    daemon.handleConnection(socket)

    const payload = vi.mocked(socket.end).mock.calls[0]?.[0]
    expect(JSON.parse(String(payload))).toMatchObject({ ok: false, retryable: true })
    socket.emit('close')
  })

  it('preserves a replacement PID record during otherwise successful idle cleanup', async () => {
    writeFileSync(
      pidPath,
      serializeDaemonPidFile({ pid: process.pid, startedAtMs: null, launchNonce: 'replacement' })
    )
    await startServer({ launchNonce: 'mine' })
    const client = new DaemonClient({ socketPath, tokenPath })
    await client.ensureConnected()

    await client.request('shutdownIfIdle', undefined)
    await waitFor(() => onIdleShutdown.mock.calls.length === 1)

    expect(JSON.parse(readFileSync(pidPath, 'utf8'))).toMatchObject({
      pid: process.pid,
      launchNonce: 'replacement'
    })
  })

  it('preserves a token file replaced before idle cleanup', async () => {
    await startServer()
    const client = new DaemonClient({ socketPath, tokenPath })
    await client.ensureConnected()
    writeFileSync(tokenPath, 'replacement-token')

    await client.request('shutdownIfIdle', undefined)
    await waitFor(() => onIdleShutdown.mock.calls.length === 1)

    expect(readFileSync(tokenPath, 'utf8')).toBe('replacement-token')
  })
})

describe('daemon PID record ownership cleanup', () => {
  let dir: string
  let pidPath: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'daemon-pid-ownership-'))
    pidPath = join(dir, 'daemon.pid')
  })

  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('unlinks only an exact PID and launch nonce match', () => {
    writeFileSync(
      pidPath,
      serializeDaemonPidFile({ pid: 123, startedAtMs: null, launchNonce: 'mine' })
    )

    expect(unlinkOwnedDaemonPidFile(pidPath, 123, 'mine')).toBe(true)
    expect(existsSync(pidPath)).toBe(false)
  })

  it.each([
    ['malformed', '{'],
    ['stale PID', serializeDaemonPidFile({ pid: 456, startedAtMs: null, launchNonce: 'mine' })],
    [
      'replacement nonce',
      serializeDaemonPidFile({ pid: 123, startedAtMs: null, launchNonce: 'new' })
    ]
  ])('preserves a %s record', (_label, contents) => {
    writeFileSync(pidPath, contents)

    expect(unlinkOwnedDaemonPidFile(pidPath, 123, 'mine')).toBe(false)
    expect(readFileSync(pidPath, 'utf8')).toBe(contents)
  })

  it('leaves a missing record missing', () => {
    expect(unlinkOwnedDaemonPidFile(pidPath, 123, 'mine')).toBe(false)
    expect(existsSync(pidPath)).toBe(false)
  })
})
