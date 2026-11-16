import { afterEach, expect, it } from 'vitest'
import { chatPathRetainedBytes } from '../native-chat/retention/chat-path-retained-bytes'
import { RendererChatFrameDelivery } from './renderer-chat-frame-delivery'

const MB = 2 ** 20
// About 1 MB once charged at UTF-16 width.
const frame = (index: number) => ({
  id: 'sub',
  ok: true,
  streaming: true,
  result: { type: 'batch', text: String(index).padEnd(MB / 2, 'x') }
})

const streams: AbortController[] = []
afterEach(() => {
  for (const stream of streams.splice(0)) {
    stream.abort()
  }
})

function open() {
  const stream = new AbortController()
  streams.push(stream)
  return { stream, delivery: new RendererChatFrameDelivery(stream.signal) }
}

it('ends a stream whose renderer stops acknowledging before main holds more than its share', () => {
  const { delivery } = open()
  let sent = 0
  while (delivery.charge(frame(sent))) {
    sent += 1
    expect(sent).toBeLessThan(40)
  }
  expect(sent).toBeGreaterThan(16)
  expect(delivery.inFlight().bytes).toBeLessThanOrEqual(32 * MB)
})

it('keeps streaming while the renderer acknowledges, and returns every byte when it ends', () => {
  const { stream, delivery } = open()
  for (let index = 1; index <= 1_000; index++) {
    expect(delivery.charge(frame(index))).toBe(true)
    if (index % 4 === 0) {
      delivery.ack(index)
    }
  }
  expect(delivery.inFlight().frames).toBe(0)
  delivery.charge(frame(0))
  expect(chatPathRetainedBytes.reading().bytes).toBeGreaterThan(0)
  stream.abort()
  expect(chatPathRetainedBytes.reading()).toEqual({ bytes: 0, items: 0 })
})
