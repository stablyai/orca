import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { connectOrcadRelayStream } from '../orcad/orcad-relay-stream-connection'
import { connectOrcadSavedSshSource } from './orcad-saved-source-connection'

vi.mock('../orcad/orcad-relay-stream-connection', () => ({
  connectOrcadRelayStream: vi.fn()
}))

function fixture() {
  const abort = new AbortController()
  const events = new EventEmitter()
  let disposed = false
  const mux = {
    isDisposed: () => disposed,
    dispose: vi.fn(() => {
      if (disposed) {
        return
      }
      disposed = true
      events.emit('dispose')
    }),
    onDispose: (callback: () => void) => {
      events.on('dispose', callback)
      return () => events.off('dispose', callback)
    }
  }
  const channel = Object.assign(new EventEmitter(), { destroy: vi.fn() })
  const client = {}
  let accept: (error: Error | undefined, channel?: unknown) => void = () => {
    throw new Error('not opened')
  }
  const connection = {
    getClient: vi.fn(() => client),
    getTarget: vi.fn(() => ({ id: 'source' })),
    getState: vi.fn(() => ({ status: 'connected' })),
    getTransportGeneration: vi.fn(() => 3),
    usesSystemSshTransport: vi.fn(() => false),
    forwardStreamLocal: vi.fn((_client, _endpoint, callback) => {
      accept = callback
    }),
    dispose: vi.fn(),
    disconnect: vi.fn()
  }
  const options = {
    connection: connection as unknown as Parameters<
      typeof connectOrcadSavedSshSource
    >[0]['connection'],
    targetId: 'source',
    source: {
      endpoint: '/saved/incumbent.sock',
      incumbentVersion: 'saved-build',
      endpointCredential: 'a'.repeat(43)
    },
    signal: abort.signal,
    assertAuthority: vi.fn(),
    initialize: vi.fn(),
    timeoutMs: 100
  }
  vi.mocked(connectOrcadRelayStream).mockImplementation(async (args) => {
    args.initialize(mux as never)
    return mux as never
  })
  return { options, connection, abort, channel, mux, accept: () => accept(undefined, channel) }
}

beforeEach(() => vi.resetAllMocks())
afterEach(() => vi.useRealTimers())

it('pins the saved endpoint, build and credential without mutating the SSH connection', async () => {
  const f = fixture()
  const pending = connectOrcadSavedSshSource(f.options)
  f.options.source.endpoint = '/replacement.sock'
  f.options.source.incumbentVersion = 'replacement-build'
  f.options.source.endpointCredential = 'b'.repeat(43)
  f.accept()
  const result = await pending
  expect(f.connection.forwardStreamLocal).toHaveBeenCalledWith(
    f.connection.getClient(),
    '/saved/incumbent.sock',
    expect.any(Function)
  )
  expect(connectOrcadRelayStream).toHaveBeenCalledWith(
    expect.objectContaining({
      stream: f.channel,
      incumbentVersion: 'saved-build',
      endpointCredential: 'a'.repeat(43)
    })
  )
  expect(f.options.initialize).toHaveBeenCalledWith(f.mux)
  result.assertCurrent()
  result.dispose()
  expect(f.channel.destroy).toHaveBeenCalledOnce()
  expect(f.connection.dispose).not.toHaveBeenCalled()
  expect(f.connection.disconnect).not.toHaveBeenCalled()
})

it.each(['target', 'client', 'generation', 'disconnected'])(
  'rejects a %s change while the channel is opening and closes only that channel',
  async (kind) => {
    const f = fixture()
    const pending = connectOrcadSavedSshSource(f.options)
    if (kind === 'target') {
      f.connection.getTarget.mockReturnValue({ id: 'other' })
    }
    if (kind === 'client') {
      f.connection.getClient.mockReturnValue({})
    }
    if (kind === 'generation') {
      f.connection.getTransportGeneration.mockReturnValue(4)
    }
    if (kind === 'disconnected') {
      f.connection.getState.mockReturnValue({ status: 'disconnected' })
    }
    f.accept()
    await expect(pending).rejects.toThrow('connection_changed')
    expect(f.channel.destroy).toHaveBeenCalledOnce()
    expect(connectOrcadRelayStream).not.toHaveBeenCalled()
    expect(f.connection.dispose).not.toHaveBeenCalled()
    expect(f.connection.disconnect).not.toHaveBeenCalled()
  }
)

it.each(['abort', 'timeout'])('destroys a late accepted channel after %s', async (kind) => {
  vi.useFakeTimers()
  const f = fixture()
  const pending = connectOrcadSavedSshSource(f.options)
  const rejected = expect(pending).rejects.toThrow(kind === 'abort' ? 'owned-abort' : 'timeout')
  if (kind === 'abort') {
    f.abort.abort(new Error('owned-abort'))
  } else {
    await vi.advanceTimersByTimeAsync(101)
  }
  await rejected
  f.accept()
  expect(f.channel.destroy).toHaveBeenCalledOnce()
  expect(connectOrcadRelayStream).not.toHaveBeenCalled()
  expect(f.connection.dispose).not.toHaveBeenCalled()
  expect(f.connection.disconnect).not.toHaveBeenCalled()
})

it('rejects authority lost during initialization and disposes owned resources', async () => {
  const f = fixture()
  f.options.initialize.mockImplementation(() => {
    f.options.assertAuthority.mockImplementation(() => {
      throw new Error('authority-lost')
    })
  })
  const pending = connectOrcadSavedSshSource(f.options)
  f.accept()
  await expect(pending).rejects.toThrow('authority-lost')
  expect(f.mux.dispose).toHaveBeenCalledOnce()
  expect(f.channel.destroy).toHaveBeenCalledOnce()
  expect(f.connection.disconnect).not.toHaveBeenCalled()
})

it('refuses system SSH without attempting a forwarding fallback', async () => {
  const f = fixture()
  f.connection.usesSystemSshTransport.mockReturnValue(true)
  await expect(connectOrcadSavedSshSource(f.options)).rejects.toThrow('connection_changed')
  expect(f.connection.forwardStreamLocal).not.toHaveBeenCalled()
  expect(connectOrcadRelayStream).not.toHaveBeenCalled()
  expect(f.connection.disconnect).not.toHaveBeenCalled()
})

it('invalidates the returned authority when its mux is disposed', async () => {
  const f = fixture()
  const pending = connectOrcadSavedSshSource(f.options)
  f.accept()
  const result = await pending
  f.mux.dispose()
  expect(() => result.assertCurrent()).toThrow('connection_changed')
  expect(f.channel.destroy).toHaveBeenCalledOnce()
  expect(f.connection.disconnect).not.toHaveBeenCalled()
})

it('keeps caller cancellation attached after connection establishment', async () => {
  const f = fixture()
  const pending = connectOrcadSavedSshSource(f.options)
  f.accept()
  const result = await pending
  f.abort.abort(new Error('later-abort'))
  expect(() => result.assertCurrent()).toThrow('later-abort')
  expect(f.mux.dispose).toHaveBeenCalledOnce()
  expect(f.channel.destroy).toHaveBeenCalledOnce()
  expect(f.connection.disconnect).not.toHaveBeenCalled()
})
