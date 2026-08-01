import { describe, expect, it, vi } from 'vitest'
import type { PeerPresenceEvent, PeerPresenceState } from '../../shared/peer-presence-event'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'

const { handleMock } = vi.hoisted(() => ({ handleMock: vi.fn() }))

vi.mock('electron', () => ({
  ipcMain: { handle: handleMock }
}))

import { registerTerminalHostPresenceHandlers } from './terminal-host-presence'

type FakeSender = {
  send: ReturnType<typeof vi.fn>
  isDestroyed: () => boolean
  once: (channel: string, listener: () => void) => void
  removeListener: (channel: string, listener: () => void) => void
  emitDestroyed: () => void
}

type Handler = (event: { sender: FakeSender }, args: unknown) => unknown

// Why: minimal fan-out stand-in, mirroring terminal-presence.test.ts's fake runtime.
function makeFakeRuntime(): {
  runtime: OrcaRuntimeService
  listeners: Set<{
    terminal: string
    sessionId: string
    listener: (event: PeerPresenceEvent) => void
  }>
} {
  const listeners = new Set<{
    terminal: string
    sessionId: string
    listener: (event: PeerPresenceEvent) => void
  }>()
  const runtime = {
    onPeerPresence: (
      terminal: string,
      sessionId: string,
      listener: (event: PeerPresenceEvent) => void
    ) => {
      const entry = { terminal, sessionId, listener }
      listeners.add(entry)
      return () => listeners.delete(entry)
    },
    dispatchPeerPresence: (
      terminal: string,
      senderSessionId: string | undefined,
      event: PeerPresenceEvent
    ) => {
      for (const entry of listeners) {
        if (entry.terminal === terminal && entry.sessionId !== senderSessionId) {
          entry.listener(event)
        }
      }
    }
  } as unknown as OrcaRuntimeService
  return { runtime, listeners }
}

function findHandler(channel: string): Handler {
  const call = handleMock.mock.calls.find((entry) => entry[0] === channel)
  if (!call) {
    throw new Error(`${channel} handler missing`)
  }
  return call[1] as Handler
}

function makeSender(destroyed = false): { sender: FakeSender } {
  const destroyedListeners = new Set<() => void>()
  return {
    sender: {
      send: vi.fn(),
      isDestroyed: () => destroyed,
      once: (channel, listener) => {
        if (channel === 'destroyed') {
          destroyedListeners.add(listener)
        }
      },
      removeListener: (channel, listener) => {
        if (channel === 'destroyed') {
          destroyedListeners.delete(listener)
        }
      },
      emitDestroyed: () => {
        for (const listener of destroyedListeners) {
          destroyedListeners.delete(listener)
          listener()
        }
      }
    }
  }
}

const sampleState: PeerPresenceState = {
  participant: { clientId: 'peer-a', name: 'Peer A', color: '#111' },
  cursor: null,
  selection: null,
  scroll: { atBottom: true, scrollTop: 0 }
}

describe('registerTerminalHostPresenceHandlers', () => {
  it('subscribes and fans a sent state out to the sender via terminalHostPresence:event', () => {
    handleMock.mockClear()
    const { runtime } = makeFakeRuntime()
    registerTerminalHostPresenceHandlers(runtime)
    const subscribe = findHandler('terminalHostPresence:subscribe')
    const send = findHandler('terminalHostPresence:send')

    const senderEvent = makeSender()
    const result = subscribe(senderEvent, { terminal: 'term-1' }) as { ok: true; requestId: string }
    expect(result.ok).toBe(true)

    send({} as never, { requestId: 'other-session', terminal: 'term-1', state: sampleState })

    expect(senderEvent.sender.send).toHaveBeenCalledWith('terminalHostPresence:event', {
      requestId: result.requestId,
      event: { type: 'state', terminal: 'term-1', state: sampleState }
    })
  })

  it('excludes the sending session from its own fan-out', () => {
    handleMock.mockClear()
    const { runtime } = makeFakeRuntime()
    registerTerminalHostPresenceHandlers(runtime)
    const subscribe = findHandler('terminalHostPresence:subscribe')
    const send = findHandler('terminalHostPresence:send')

    const senderEvent = makeSender()
    const result = subscribe(senderEvent, { terminal: 'term-1' }) as { ok: true; requestId: string }

    send({} as never, { requestId: result.requestId, terminal: 'term-1', state: sampleState })

    expect(senderEvent.sender.send).not.toHaveBeenCalled()
  })

  it('dispatches a "left" event to other subscribers on unsubscribe and cleans up the session', () => {
    handleMock.mockClear()
    const { runtime } = makeFakeRuntime()
    registerTerminalHostPresenceHandlers(runtime)
    const subscribe = findHandler('terminalHostPresence:subscribe')
    const unsubscribe = findHandler('terminalHostPresence:unsubscribe')
    const send = findHandler('terminalHostPresence:send')

    const hostEvent = makeSender()
    const otherEvent = makeSender()
    const hostResult = subscribe(hostEvent, { terminal: 'term-1' }) as {
      ok: true
      requestId: string
    }
    const otherResult = subscribe(otherEvent, { terminal: 'term-1' }) as {
      ok: true
      requestId: string
    }

    unsubscribe({} as never, { requestId: hostResult.requestId })

    expect(otherEvent.sender.send).toHaveBeenCalledWith('terminalHostPresence:event', {
      requestId: otherResult.requestId,
      event: { type: 'left', terminal: 'term-1', clientId: 'host' }
    })

    // Why: unsubscribe must drop the session so a later send no longer reaches the host's dead listener.
    hostEvent.sender.send.mockClear()
    send({} as never, { requestId: otherResult.requestId, terminal: 'term-1', state: sampleState })
    expect(hostEvent.sender.send).not.toHaveBeenCalled()
  })

  it('unsubscribing an unknown requestId is a no-op that still resolves ok', () => {
    handleMock.mockClear()
    const { runtime } = makeFakeRuntime()
    registerTerminalHostPresenceHandlers(runtime)
    const unsubscribe = findHandler('terminalHostPresence:unsubscribe')

    const result = unsubscribe({} as never, { requestId: 'never-subscribed' })
    expect(result).toEqual({ ok: true })
  })

  it('does not deliver events to a destroyed sender', () => {
    handleMock.mockClear()
    const { runtime } = makeFakeRuntime()
    registerTerminalHostPresenceHandlers(runtime)
    const subscribe = findHandler('terminalHostPresence:subscribe')
    const send = findHandler('terminalHostPresence:send')

    const destroyedEvent = makeSender(true)
    subscribe(destroyedEvent, { terminal: 'term-1' })
    const otherEvent = makeSender()
    const otherResult = subscribe(otherEvent, { terminal: 'term-1' }) as {
      ok: true
      requestId: string
    }

    send({} as never, { requestId: otherResult.requestId, terminal: 'term-1', state: sampleState })

    expect(destroyedEvent.sender.send).not.toHaveBeenCalled()
  })

  it('tears the session down when the owning sender is destroyed without unsubscribing', () => {
    handleMock.mockClear()
    const { runtime, listeners } = makeFakeRuntime()
    registerTerminalHostPresenceHandlers(runtime)
    const subscribe = findHandler('terminalHostPresence:subscribe')

    const hostEvent = makeSender()
    const otherEvent = makeSender()
    subscribe(hostEvent, { terminal: 'term-1' })
    const otherResult = subscribe(otherEvent, { terminal: 'term-1' }) as {
      ok: true
      requestId: string
    }
    expect(listeners.size).toBe(2)

    // Why: a window reload or close never sends the explicit unsubscribe.
    hostEvent.sender.emitDestroyed()

    expect(listeners.size).toBe(1)
    expect(otherEvent.sender.send).toHaveBeenCalledWith('terminalHostPresence:event', {
      requestId: otherResult.requestId,
      event: { type: 'left', terminal: 'term-1', clientId: 'host' }
    })
  })
})
