import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { registerServeSignalHandlers, type ServeSignalSource } from './serve-signal-handlers'

function signalSourceFor(emitter: EventEmitter): ServeSignalSource {
  return {
    on: (event, listener) => emitter.on(event, listener),
    removeListener: (event, listener) => emitter.removeListener(event, listener),
    listeners: (event) =>
      emitter
        .listeners(event)
        .filter(
          (listener): listener is (signal: NodeJS.Signals) => void => typeof listener === 'function'
        )
  }
}

describe('registerServeSignalHandlers', () => {
  it('retries a vetoed quit on every delivered signal', () => {
    const signalSource = new EventEmitter()
    const quitApplication = vi.fn()

    registerServeSignalHandlers(signalSourceFor(signalSource), quitApplication)
    signalSource.emit('SIGINT')
    signalSource.emit('SIGINT')
    signalSource.emit('SIGTERM')
    signalSource.emit('SIGHUP')

    expect(quitApplication).toHaveBeenCalledTimes(4)
    expect(signalSource.listenerCount('SIGINT')).toBe(1)
    expect(signalSource.listenerCount('SIGTERM')).toBe(1)
    expect(signalSource.listenerCount('SIGHUP')).toBe(1)
  })

  it('drops every earlier listener before re-adding it, so Node reinstalls its signal handler', () => {
    const signalSource = new EventEmitter()
    const earlier = vi.fn()
    signalSource.on('SIGTERM', earlier)
    const counts: number[] = []
    signalSource.on('removeListener', (event) => {
      if (event === 'SIGTERM') {
        counts.push(signalSource.listenerCount('SIGTERM'))
      }
    })
    const quitApplication = vi.fn()

    registerServeSignalHandlers(signalSourceFor(signalSource), quitApplication)
    signalSource.emit('SIGTERM')

    // Node closes a signal's native handle only when its last listener is removed.
    expect(counts).toEqual([0])
    expect(signalSource.listeners('SIGTERM')).toEqual([earlier, quitApplication])
    expect(earlier).toHaveBeenCalledOnce()
    expect(quitApplication).toHaveBeenCalledOnce()
  })
})
