import type { Socket } from 'node:net'
import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { writeNotifyWithSettlement } from './daemon-client-notify-settlement'
import { sendDaemonHello } from './daemon-client-hello-handshake'
import { startResponsiveDeadline } from './daemon-responsive-deadline'
import { PROTOCOL_VERSION } from './types'

// The workstation's main process blocked for 1–3 s inside each synchronous CreateProcess (git
// spawns), most of the time. After such a freeze Node runs due timers before the I/O that completed
// meanwhile, so a wall-clock deadline condemned a daemon that had answered: the keystroke settlement
// tore the link down, and the reconnect's hello and connect timed out the same way.

/** Blocks this thread, as a synchronous spawn does. */
function freeze(ms: number): void {
  const until = performance.now() + ms
  while (performance.now() < until) {
    // busy wait
  }
}

/** Code after this runs in a check phase: immediates it queues run only after the next timers phase. */
function enterCheckPhase(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

describe('daemon link deadlines across a main-process freeze', () => {
  it('keeps a write the daemon accepted while main was frozen', async () => {
    // The OS completes the write during the freeze; Node delivers it after the timers phase.
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a partial socket; writeNotifyWithSettlement only calls write on it.
    const socket = {
      write: (_encoded: string, callback: (error?: Error | null) => void) => {
        setImmediate(() => callback(null))
        return true
      }
    } as unknown as Socket
    const onUndeliverable = vi.fn()
    await enterCheckPhase()
    const pending = writeNotifyWithSettlement({
      socket,
      message: { id: 'notify-1', type: 'write', payload: { sessionId: 'pty-1', data: 'k' } },
      timeoutMs: 300,
      onUndeliverable
    })
    freeze(900)
    await expect(pending).resolves.toEqual({ outcome: 'accepted' })
    expect(onUndeliverable).not.toHaveBeenCalled()
  })

  it('still condemns a write that never settles while main runs', async () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a partial socket; writeNotifyWithSettlement only calls write on it.
    const socket = { write: () => true } as unknown as Socket
    const onUndeliverable = vi.fn()
    const startedAt = performance.now()
    const settlement = await writeNotifyWithSettlement({
      socket,
      message: { id: 'notify-2', type: 'write', payload: { sessionId: 'pty-1', data: 'k' } },
      timeoutMs: 300,
      onUndeliverable
    })
    expect(settlement).toEqual({
      outcome: 'unverifiable',
      reason: 'settlement_timeout',
      bytesHandedToTransport: true
    })
    expect(onUndeliverable).toHaveBeenCalledOnce()
    expect(performance.now() - startedAt).toBeGreaterThanOrEqual(290)
  })

  it('accepts a hello reply that arrived while main was frozen', async () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fake gets write, destroy and pause just below, the members the hello handshake calls besides its listeners.
    const socket = new EventEmitter() as EventEmitter & {
      write: (data: string) => boolean
      destroy: () => void
      pause: () => void
    }
    socket.write = () => {
      setImmediate(() =>
        socket.emit(
          'data',
          Buffer.from(
            `${JSON.stringify({
              type: 'hello',
              ok: true,
              daemonIdentity: { pid: 1, startedAtMs: 1, launchNonce: 'nonce' }
            })}\n`
          )
        )
      )
      return true
    }
    socket.destroy = vi.fn()
    socket.pause = () => {}
    await enterCheckPhase()
    const pending = sendDaemonHello({
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fake implements every Socket member the hello handshake uses.
      socket: socket as unknown as Socket,
      token: 'token',
      role: 'control',
      timeoutMs: 300,
      protocolVersion: PROTOCOL_VERSION,
      clientId: 'client'
    })
    freeze(900)
    await expect(pending).resolves.toMatchObject({ identity: { pid: 1 } })
    expect(socket.destroy).not.toHaveBeenCalled()
  })
})

describe('startResponsiveDeadline', () => {
  it('expires after the time the event loop could run', async () => {
    const onExpire = vi.fn()
    const startedAt = performance.now()
    startResponsiveDeadline(300, onExpire)
    await vi.waitFor(() => expect(onExpire).toHaveBeenCalledOnce(), { timeout: 2_000 })
    expect(performance.now() - startedAt).toBeGreaterThanOrEqual(290)
  })

  it('credits a freeze as one tick, not its length', async () => {
    const onExpire = vi.fn()
    await enterCheckPhase()
    const startedAt = performance.now()
    startResponsiveDeadline(600, onExpire)
    freeze(1_000)
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(onExpire).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(onExpire).toHaveBeenCalledOnce(), { timeout: 2_000 })
    // 1 s frozen plus at least the 350 ms of running time the deadline still needed.
    expect(performance.now() - startedAt).toBeGreaterThanOrEqual(1_300)
  })

  it('never expires once cancelled', async () => {
    const onExpire = vi.fn()
    const cancel = startResponsiveDeadline(50, onExpire)
    cancel()
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(onExpire).not.toHaveBeenCalled()
  })
})
