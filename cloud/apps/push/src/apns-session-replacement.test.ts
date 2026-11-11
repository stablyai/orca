import { EventEmitter } from 'node:events'
import { expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  read: vi.fn(async () => ({ status: 200, body: '' }))
}))
vi.mock('node:http2', async (original) => ({
  ...(await original<typeof import('node:http2')>()),
  connect: mocks.connect
}))
vi.mock('./apns-stream-response.js', () => ({ readApnsStreamResponse: mocks.read }))
import { createApnsHttp2Transport } from './apns-http2-transport.js'

it('keeps the replacement cached when the draining session closes later', async () => {
  const sessions: Array<
    EventEmitter & {
      closed: boolean
      destroyed: boolean
      request: ReturnType<typeof vi.fn>
      close: ReturnType<typeof vi.fn>
    }
  > = []
  mocks.connect.mockImplementation(() => {
    const session = Object.assign(new EventEmitter(), {
      closed: false,
      destroyed: false,
      request: vi.fn(() => ({})),
      close: vi.fn()
    })
    sessions.push(session)
    return session
  })
  const transport = createApnsHttp2Transport()
  const request = { host: 'api.push.apple.com', path: '/synthetic', headers: {}, body: '{}' }
  await transport(request)
  sessions[0]!.closed = true
  await transport(request)
  sessions[0]!.emit('close')
  sessions[0]!.emit('error', new Error('old-session'))
  await transport(request)
  expect(sessions).toHaveLength(2)
  expect(sessions[1]!.request).toHaveBeenCalledTimes(2)
  transport.close()
  expect(sessions[1]!.close).toHaveBeenCalledOnce()
})
