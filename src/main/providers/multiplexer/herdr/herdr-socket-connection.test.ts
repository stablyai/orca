import { EventEmitter } from 'node:events'
import type { Socket } from 'node:net'
import { describe, expect, it, vi } from 'vitest'
import { HerdrSocketConnection } from './herdr-socket-connection'
import { HerdrRuntimeError } from './herdr-runtime-contract'

type SocketHandle = EventEmitter & {
  write: ReturnType<typeof vi.fn>
  destroy: ReturnType<typeof vi.fn>
}

function nextSocket(): SocketHandle {
  const socket = Object.assign(new EventEmitter(), {
    write: vi.fn(() => true),
    destroy: vi.fn()
  })
  return socket as unknown as SocketHandle
}

function createSocketFactory(state: { sockets: SocketHandle[] }) {
  return (_socketPath: string): Socket => {
    const socket = nextSocket()
    state.sockets.push(socket)
    return socket as unknown as Socket
  }
}

function options(overrides: Partial<ConstructorParameters<typeof HerdrSocketConnection>[0]> = {}) {
  const state: { sockets: SocketHandle[] } = { sockets: [] }
  return {
    state,
    connection: new HerdrSocketConnection({
      sessionName: 'test-session',
      timeoutMs: 1000,
      socketFactory: createSocketFactory(state),
      ...overrides
    })
  }
}

describe('HerdrSocketConnection', () => {
  it('reports its session and socket path', () => {
    const { connection } = options()
    const state = connection.getState()
    expect(state.sessionName).toBe('test-session')
    expect(state.socketPath).toContain('.config/herdr/sessions/test-session/herdr.sock')
  })

  it('resolves a matched response by request id', async () => {
    const { connection, state } = options()
    const promise = connection.request('workspace.list', {})
    const socket = state.sockets[0]
    socket.emit('connect')
    const written = socket.write.mock.calls[0][0] as string
    const requestId = JSON.parse(written).id as string
    socket.emit(
      'data',
      Buffer.from(`${JSON.stringify({ id: requestId, result: { type: 'pong' } })}\n`)
    )
    await expect(promise).resolves.toEqual({ type: 'pong' })
  })

  it('rejects with the server error code when the response carries an error', async () => {
    const { connection, state } = options()
    const promise = connection.request('workspace.list', {})
    const socket = state.sockets[0]
    socket.emit('connect')
    const requestId = JSON.parse(socket.write.mock.calls[0][0] as string).id as string
    socket.emit(
      'data',
      Buffer.from(
        `${JSON.stringify({ id: requestId, error: { code: 'not_git_worktree', message: 'boom' } })}\n`
      )
    )
    const rejection = await promise.catch((error: unknown) => error)
    expect(rejection).toBeInstanceOf(HerdrRuntimeError)
    expect(rejection).toMatchObject({ code: 'not_git_worktree', message: 'boom' })
  })

  it('surfaces a server error that carries an empty id instead of reporting closed', async () => {
    const { connection, state } = options()
    const promise = connection.request('workspace.report_metadata', { workspace_id: 'w1' })
    const socket = state.sockets[0]
    socket.emit('connect')
    socket.emit(
      'data',
      Buffer.from(
        `${JSON.stringify({ id: '', error: { code: 'invalid_request', message: 'missing field `source`' } })}\n`
      )
    )
    socket.emit('close')
    const rejection = await promise.catch((error: unknown) => error)
    expect(rejection).toBeInstanceOf(HerdrRuntimeError)
    expect(rejection).toMatchObject({
      code: 'invalid_request',
      message: 'missing field `source`'
    })
  })

  it('times out the connection when the server never opens', async () => {
    const { connection } = options({ timeoutMs: 50 })
    await expect(connection.request('workspace.list', {})).rejects.toThrow('timed out')
  })

  it('times out a request that never gets a response', async () => {
    const { connection, state } = options({ timeoutMs: 50 })
    const promise = connection.requestWithOptions('workspace.list', {}, 40)
    const socket = state.sockets[0]
    socket.emit('connect')
    await expect(promise).rejects.toThrow('Request workspace.list timed out')
  })

  it('rejects when the socket errors before responding', async () => {
    const { connection, state } = options()
    const promise = connection.request('workspace.list', {})
    const socket = state.sockets[0]
    socket.emit('connect')
    socket.emit('error', new Error('connection reset'))
    await expect(promise).rejects.toThrow('connection reset')
  })

  it('rejects when the socket closes before responding', async () => {
    const { connection, state } = options()
    const promise = connection.request('workspace.list', {})
    const socket = state.sockets[0]
    socket.emit('connect')
    socket.emit('close')
    await expect(promise).rejects.toThrow('closed before response')
  })
})
