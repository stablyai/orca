import { EventEmitter } from 'node:events'
import type { ClientChannel } from 'ssh2'
import { expect, it, vi } from 'vitest'
import { RELAY_SENTINEL } from '../remote-exec/remote-frame-protocol'
import { waitForSentinel } from './ssh-relay-sentinel'

it.each(Array.from({ length: RELAY_SENTINEL.length + 1 }, (_, i) => i))(
  'preserves the marker and binary payload when split at byte %i',
  async (split) => {
    const channel = Object.assign(new EventEmitter(), {
      stderr: new EventEmitter(),
      stdin: { write: vi.fn(() => true) },
      close: vi.fn()
    })
    const pending = waitForSentinel(channel as unknown as ClientChannel)
    const marker = Buffer.from(RELAY_SENTINEL)
    const payload = Buffer.from([0, 255, 128, 10, 13, 1])
    channel.emit('data', Buffer.alloc(63 * 1024, 120))
    channel.emit('data', marker.subarray(0, split))
    channel.emit('data', Buffer.concat([marker.subarray(split), payload]))
    const transport = await pending
    const received: Buffer[] = []
    transport.onData((bytes) => received.push(bytes))
    expect(Buffer.concat(received)).toEqual(payload)
    expect(channel.close).not.toHaveBeenCalled()
  }
)
