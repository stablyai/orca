import type { Socket } from 'node:net'
import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { DaemonPendingRequests } from '../daemon-client-pending-requests'
import { requestDaemonRpc } from '../daemon-client-rpc-request'
import { sendDaemonHello } from '../daemon-client-hello-handshake'
import { writeNotifyWithSettlement } from '../daemon-client-notify-settlement'
import { startResponsiveDeadline } from '../daemon-responsive-deadline'
import { PROTOCOL_VERSION } from '../../../protocol/daemon-protocol-version'

// The OS finishes the connect during the freeze; Node delivers it after the next timers phase.
vi.mock('node:net', () => ({
  connect: () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: connectDaemonSocket only listens for connect/error and may call destroy.
    const socket = new EventEmitter() as EventEmitter & { destroy: () => void; destroyed: boolean }
    socket.destroyed = false
    socket.destroy = () => {
      socket.destroyed = true
    }
    setImmediate(() => socket.emit('connect'))
    return socket
  }
}))

const { connectDaemonSocket, waitForDaemonConnectionAttempt } =
  await import('../daemon-client-socket-connect')

const TIMEOUT_MS = 50
// Longer than the deadline plus the late-tick tolerance, as a synchronous CreateProcess stall is.
const FREEZE_MS = 250

function freeze(ms: number): void {
  const until = performance.now() + ms
  while (performance.now() < until) {
    // busy wait, as a synchronous spawn blocks
  }
}

/**
 * Starts `operation` from a check phase and then blocks the thread, so the completion it schedules
 * with setImmediate runs only after the timers phase that follows the freeze — the order Node
 * delivers I/O that finished while main was frozen.
 */
async function startThenFreeze<T>(operation: () => Promise<T>): Promise<T> {
  await new Promise((resolve) => setImmediate(resolve))
  const pending = operation()
  freeze(FREEZE_MS)
  return pending
}

describe('daemon link deadlines across a main-process freeze', () => {
  it('keeps a write the daemon accepted while main was frozen', async () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: writeNotifyWithSettlement only calls write.
    const socket = {
      write: (_encoded: string, callback: (error?: Error | null) => void) => {
        setImmediate(() => callback(null))
        return true
      }
    } as unknown as Socket
    const onUndeliverable = vi.fn()
    const settlement = await startThenFreeze(() =>
      writeNotifyWithSettlement({
        socket,
        message: { id: 'notify-1', type: 'write', payload: { sessionId: 'pty-1', data: 'k' } },
        timeoutMs: TIMEOUT_MS,
        onUndeliverable
      })
    )
    expect(settlement).toEqual({ outcome: 'accepted' })
    expect(onUndeliverable).not.toHaveBeenCalled()
  })

  it('accepts a hello reply that arrived while main was frozen', async () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: write, destroy and pause are assigned below; the handshake uses nothing else besides listeners.
    const socket = new EventEmitter() as EventEmitter & {
      write: () => boolean
      destroy: () => void
      pause: () => void
    }
    const reply = {
      type: 'hello',
      ok: true,
      daemonIdentity: { pid: 1, startedAtMs: 1, launchNonce: 'n' }
    }
    socket.write = () => {
      setImmediate(() => socket.emit('data', Buffer.from(`${JSON.stringify(reply)}\n`)))
      return true
    }
    socket.destroy = vi.fn()
    socket.pause = () => {}
    const hello = await startThenFreeze(() =>
      sendDaemonHello({
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fake implements every Socket member the handshake uses.
        socket: socket as unknown as Socket,
        token: 'token',
        role: 'control',
        timeoutMs: TIMEOUT_MS,
        protocolVersion: PROTOCOL_VERSION,
        clientId: 'client'
      })
    )
    expect(hello.identity).toMatchObject({ pid: 1 })
    expect(socket.destroy).not.toHaveBeenCalled()
  })

  it('keeps a connection that completed while main was frozen', async () => {
    const socket = await startThenFreeze(() =>
      connectDaemonSocket('orca-freeze-test-pipe', TIMEOUT_MS)
    )
    expect(socket.destroyed).toBe(false)
  })

  it('joins a connection attempt that finished while main was frozen', async () => {
    await expect(
      startThenFreeze(() =>
        waitForDaemonConnectionAttempt(new Promise((resolve) => setImmediate(resolve)), TIMEOUT_MS)
      )
    ).resolves.toBeUndefined()
  })

  it('resolves a request whose reply arrived while main was frozen', async () => {
    const pendingRequests = new DaemonPendingRequests()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: requestDaemonRpc only calls write.
    const socket = {
      write: () => {
        setImmediate(() => pendingRequests.settle({ id: 'req-1', ok: true, payload: 'pong' }))
        return true
      }
    } as unknown as Socket
    const reply = await startThenFreeze(() =>
      requestDaemonRpc<string>({
        socket,
        pendingRequests,
        id: 'req-1',
        type: 'ping',
        payload: undefined,
        timeoutMs: TIMEOUT_MS,
        unmatchedCancelGraceMs: TIMEOUT_MS,
        onCreateCancellationFailure: vi.fn(),
        settleCreateCancellation: vi.fn()
      })
    )
    expect(reply).toBe('pong')
  })

  it('still condemns a peer that never answers while main runs', async () => {
    const onExpire = vi.fn()
    const startedAt = performance.now()
    startResponsiveDeadline(TIMEOUT_MS, onExpire)
    await vi.waitFor(() => expect(onExpire).toHaveBeenCalledOnce(), { timeout: 1_000 })
    expect(performance.now() - startedAt).toBeGreaterThanOrEqual(TIMEOUT_MS - 5)
  })
})
