import { describe, expect, it, vi } from 'vitest'
import { connectCopilotServer } from './copilot-server-connection'
import { createFakeCopilotServer } from './fake-copilot-server-fixture'

function connectToFake(autoReplies?: Record<string, unknown>) {
  const fake = createFakeCopilotServer(autoReplies)
  const onNotification = vi.fn()
  const onRequest = vi.fn((): unknown => undefined)
  const onClosed = vi.fn()
  const onReady = vi.fn()
  const connection = connectCopilotServer({
    child: fake.child,
    initializeParams: { processId: 1 },
    onReady,
    onNotification,
    onRequest,
    onClosed
  })
  return { fake, connection, onNotification, onRequest, onClosed, onReady }
}

describe('connectCopilotServer', () => {
  it('sends initialize, then initialized, then reports ready', async () => {
    const { fake, connection, onReady } = connectToFake()
    await connection.ready
    await fake.waitFor((message) => message.method === 'initialized')
    expect(onReady).toHaveBeenCalledWith(connection)
  })

  it('resolves requests with the server result', async () => {
    const { fake, connection } = connectToFake()
    await connection.ready
    const pending = connection.request('checkStatus', {})
    const request = await fake.waitFor((message) => message.method === 'checkStatus')
    fake.reply(request.id, { status: 'OK' })
    await expect(pending).resolves.toEqual({ status: 'OK' })
  })

  it('times out requests the server never answers', async () => {
    const { connection } = connectToFake()
    await connection.ready
    await expect(connection.request('checkStatus', {}, 10)).rejects.toThrow(/timed out/)
  })

  it('forwards server notifications and answers server requests', async () => {
    const { fake, connection, onNotification, onRequest } = connectToFake()
    await connection.ready
    fake.notify('didChangeStatus', { kind: 'Normal' })
    await vi.waitFor(() =>
      expect(onNotification).toHaveBeenCalledWith('didChangeStatus', { kind: 'Normal' })
    )
    onRequest.mockReturnValueOnce({ success: true })
    fake.requestFromServer('s-1', 'window/showDocument', {})
    fake.requestFromServer('s-2', 'client/registerCapability', {})
    const custom = await fake.waitFor((m) => m.id === 's-1' && m.method === undefined)
    const fallback = await fake.waitFor((m) => m.id === 's-2' && m.method === undefined)
    expect(custom.result).toEqual({ success: true })
    expect(fallback.result).toBeNull()
  })

  it('dispose sends exit, kills the process, rejects pending requests, and reports closed once', async () => {
    const { fake, connection, onClosed } = connectToFake()
    await connection.ready
    const pending = connection.request('checkStatus', {}, 60_000)
    connection.dispose()
    connection.dispose()
    await expect(pending).rejects.toThrow(/closed/)
    await fake.waitFor((message) => message.method === 'exit')
    expect(fake.child.kill).toHaveBeenCalledTimes(1)
    expect(onClosed).toHaveBeenCalledTimes(1)
    await expect(connection.request('x', {})).rejects.toThrow(/closed/)
  })

  it('closes when the server process exits', async () => {
    const { fake, connection, onClosed } = connectToFake()
    await connection.ready
    fake.child.emit('exit', 1)
    expect(connection.isDisposed()).toBe(true)
    expect(onClosed).toHaveBeenCalledTimes(1)
  })

  it('survives stdout and stderr pipe errors instead of throwing in main', async () => {
    const { fake, connection } = connectToFake()
    await connection.ready
    expect(() => fake.child.stdout.emit('error', new Error('EPIPE'))).not.toThrow()
    expect(() => fake.child.stderr.emit('error', new Error('EPIPE'))).not.toThrow()
    expect(connection.isDisposed()).toBe(false)
  })
})
