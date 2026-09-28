import { SERVE_STOP_READY, SERVE_STOP_REQUEST } from '../../shared/serve-supervisor-control'
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
    signalSource.emit('SIGHUP')

    expect(quitApplication).toHaveBeenCalledTimes(4)
    expect(signalSource.listenerCount('SIGINT')).toBe(1)
    expect(signalSource.listenerCount('SIGTERM')).toBe(1)
    expect(signalSource.listenerCount('SIGHUP')).toBe(1)
  })
})

it('installs stop handling before advertising it and ignores unrelated IPC', () => {
  const signalSource = Object.assign(new EventEmitter(), {
    send: vi.fn((message: string) => {
      expect(message).toBe(SERVE_STOP_READY)
      signalSource.emit('message', SERVE_STOP_REQUEST)
      return true
    })
  })
  const quit = vi.fn()
  registerServeSignalHandlers(signalSource, quit)
  expect(quit).toHaveBeenCalledOnce()
  signalSource.emit('message', { type: SERVE_STOP_REQUEST })
  signalSource.emit('message', 'unknown')
  expect(quit).toHaveBeenCalledOnce()
  signalSource.emit('message', SERVE_STOP_REQUEST)
  expect(quit).toHaveBeenCalledTimes(2)
})

it('retains signal handling after an IPC announcement fails', () => {
  const signalSource = Object.assign(new EventEmitter(), {
    send: () => {
      throw new Error('closed')
    }
  })
  const quit = vi.fn()
  registerServeSignalHandlers(signalSource, quit)
  signalSource.emit('SIGINT')
  expect(quit).toHaveBeenCalledOnce()
})
