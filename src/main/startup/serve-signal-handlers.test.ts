import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { registerServeSignalHandlers } from './serve-signal-handlers'

describe('registerServeSignalHandlers', () => {
  it('retries a vetoed quit on every delivered signal', () => {
    const signalSource = new EventEmitter()
    const quitApplication = vi.fn()

    registerServeSignalHandlers(signalSource, quitApplication)
    signalSource.emit('SIGINT')
    signalSource.emit('SIGINT')
    signalSource.emit('SIGTERM')

    expect(quitApplication).toHaveBeenCalledTimes(3)
    expect(signalSource.listenerCount('SIGINT')).toBe(1)
    expect(signalSource.listenerCount('SIGTERM')).toBe(1)
  })
})
