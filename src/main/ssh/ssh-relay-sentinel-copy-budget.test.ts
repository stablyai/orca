import { EventEmitter } from 'node:events'
import type { ClientChannel } from 'ssh2'
import { expect, it, vi } from 'vitest'
import { RELAY_SENTINEL } from './relay-protocol'
import { waitForSentinel } from './ssh-relay-deploy-helpers'

it.each([1, 256])('copies each startup prefix once across %i chunks', async (chunks) => {
  const channel = Object.assign(new EventEmitter(), {
    stderr: new EventEmitter(),
    stdin: { write: vi.fn(() => true) },
    close: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn()
  })
  const pending = waitForSentinel(channel as unknown as ClientChannel)
  const chunk = Buffer.alloc((64 * 1024) / chunks, 120)
  const concat = vi.spyOn(Buffer, 'concat')
  let calls = 0
  let copied = 0
  try {
    for (let i = 0; i < chunks; i++) {
      channel.emit('data', chunk)
    }
    calls = concat.mock.calls.length
    copied = concat.mock.calls.reduce(
      (sum, [buffers]) => sum + buffers.reduce((bytes, buffer) => bytes + buffer.length, 0),
      0
    )
  } finally {
    concat.mockRestore()
  }
  channel.emit('data', Buffer.from(`${RELAY_SENTINEL}first-frame`))
  const transport = await pending
  const received: string[] = []
  transport.onData((bytes) => received.push(bytes.toString()))
  expect(received).toEqual(['first-frame'])
  expect(channel.close).not.toHaveBeenCalled()
  expect(calls).toBe(chunks - 1)
  expect(copied).toBe(chunk.length * ((chunks * (chunks + 1)) / 2 - 1))
})

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
