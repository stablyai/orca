import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import type { ClientChannel } from 'ssh2'
import { waitForSentinel } from './ssh-relay-sentinel'
import { RELAY_SENTINEL } from '../../protocol/relay-handshake'
import './ssh-relay-version-mismatch-error'
import './ssh-relay-credential-mismatch-error'

type MockChannel = ClientChannel & {
  stdin: EventEmitter & { write: ReturnType<typeof vi.fn> }
}

function createMockChannel(): MockChannel {
  return Object.assign(new EventEmitter(), {
    stderr: Object.assign(new EventEmitter(), { resume: vi.fn() }),
    stdin: Object.assign(new EventEmitter(), { write: vi.fn(() => true) }),
    close: vi.fn(),
    resume: vi.fn()
  }) as unknown as MockChannel
}

describe('waitForSentinel', () => {
  it('buffers post-sentinel chunks until the transport subscribes', async () => {
    const channel = createMockChannel()
    const transportPromise = waitForSentinel(channel)

    channel.emit('data', Buffer.from(RELAY_SENTINEL))
    channel.emit('data', Buffer.from('first-frame-after-sentinel'))

    const transport = await transportPromise
    const chunks: string[] = []
    transport.onData((chunk) => chunks.push(chunk.toString('utf-8')))

    expect(chunks).toEqual(['first-frame-after-sentinel'])
  })

  it('does not count same-chunk post-sentinel payload against the startup buffer cap', async () => {
    const channel = createMockChannel()
    const transportPromise = waitForSentinel(channel)
    const postSentinelPayload = Buffer.alloc(70 * 1024, 'b')

    channel.emit(
      'data',
      Buffer.concat([
        Buffer.alloc(64 * 1024, 'a'),
        Buffer.from(RELAY_SENTINEL),
        postSentinelPayload
      ])
    )

    const transport = await transportPromise
    const chunks: Buffer[] = []
    transport.onData((chunk) => chunks.push(chunk))

    expect(Buffer.concat(chunks)).toEqual(postSentinelPayload)
    expect(channel.close).not.toHaveBeenCalled()
  })
})
