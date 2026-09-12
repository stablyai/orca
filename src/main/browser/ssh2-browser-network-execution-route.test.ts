import { PassThrough } from 'node:stream'
import type { Client, ClientChannel } from 'ssh2'
import { describe, expect, it, vi } from 'vitest'
import type { RouteBase } from './ssh-browser-network-execution-route'
import { createSsh2ExecutionRoute } from './ssh2-browser-network-execution-route'

function setup() {
  let callback!: (error: Error | undefined, channel: ClientChannel) => void
  const client = {} as Client
  const release = vi.fn()
  const invalidation = new AbortController()
  const connection = {
    getClient: () => client,
    getState: () => ({ status: 'connected' }),
    forwardOut: vi.fn((_client, _socket, _source, _sourcePort, _host, _port, cb) => {
      callback = cb
    })
  }
  const base = {
    key: 'ssh:a',
    authority: { targetId: 'a' },
    connection,
    invalidation,
    releaseInvalidation: release,
    dependencies: {
      connectionManager: { getConnection: () => connection },
      isCurrentAuthority: () => true
    }
  } as unknown as RouteBase
  const route = createSsh2ExecutionRoute(base, client)
  const socket = route.connect({ host: 'internal', port: 443 })
  socket.on('error', () => {})
  const channel = new PassThrough({ emitClose: false }) as PassThrough & { close: () => void }
  channel.close = vi.fn(() => {
    channel.destroy()
  })
  return {
    route,
    socket,
    channel,
    release,
    invalidation,
    connection,
    complete: (error?: Error) => callback(error, channel as unknown as ClientChannel)
  }
}

describe('ssh2 browser route confirmed local closure', () => {
  it('retains authority until an attached raw channel closes, not synthetic socket close', async () => {
    const state = setup()
    state.complete()
    await Promise.resolve()
    const close = state.route.close()
    expect(state.route.close()).toBe(close)
    expect(state.socket.destroyed).toBe(true)
    expect(state.release).not.toHaveBeenCalled()
    await Promise.resolve()
    expect(state.release).not.toHaveBeenCalled()
    state.channel.emit('close')
    await close
    expect(state.release).toHaveBeenCalledOnce()
  })

  it('waits for pending callbacks and closes late channels before releasing authority', async () => {
    const state = setup()
    state.invalidation.abort()
    const close = state.route.close()
    await Promise.resolve()
    expect(state.release).not.toHaveBeenCalled()
    state.complete()
    await Promise.resolve()
    expect(state.channel.close).toHaveBeenCalledOnce()
    expect(state.release).not.toHaveBeenCalled()
    state.channel.emit('close')
    await close
    expect(state.release).toHaveBeenCalledOnce()
  })

  it('releases after a late refused channel open without requiring a nonexistent channel close', async () => {
    const state = setup()
    const close = state.route.close()
    state.complete(new Error('refused'))
    await close
    expect(state.release).toHaveBeenCalledOnce()
    expect(state.channel.close).not.toHaveBeenCalled()
  })

  it('retains failed cleanup and returns the same rejected close on retry', async () => {
    const state = setup()
    const close = state.route.close()
    state.channel.close = () => {
      throw new Error('close failed')
    }
    state.complete()
    await expect(close).rejects.toThrow('close failed')
    expect(state.route.close()).toBe(close)
    expect(state.release).not.toHaveBeenCalled()
  })

  it('does not treat a consumer-destroyed wrapper as raw channel closure', async () => {
    const state = setup()
    state.complete()
    await Promise.resolve()
    state.socket.destroy()
    const close = state.route.close()
    await Promise.resolve()
    expect(state.release).not.toHaveBeenCalled()
    state.channel.emit('close')
    await close
    expect(state.release).toHaveBeenCalledOnce()
  })

  it('does not mistake an admission-shaped message for proof that no channel opened', async () => {
    const state = setup()
    state.complete(new Error('refused'))
    await Promise.resolve()
    state.connection.forwardOut.mockImplementation(() => {
      throw new Error('ssh_connection_work_admission_closed')
    })
    const socket = state.route.connect({ host: 'internal', port: 443 })
    socket.on('error', () => {})
    await expect(state.route.close()).rejects.toThrow('ssh_connection_work_admission_closed')
    expect(state.release).not.toHaveBeenCalled()
  })
})
