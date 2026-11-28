// Guards #51086 (bot chats now relay too): a relay paused at its cap asks its client for acks on a
// backoff; while the client's stream is backed up it neither asks nor polls, however long that
// lasts, and asks again once the stream drains.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ProviderRelayAttachment, type ProviderRelayStream } from './provider-relay-attachment'

afterEach(() => {
  vi.useRealTimers()
})

describe('paused relay ack nudges', () => {
  it('wait on a backed-up stream without polling, and ask again once it drains', () => {
    vi.useFakeTimers()
    let backedUp = true
    let writes = 0
    const drains = new Set<() => void>()
    const socket: ProviderRelayStream['socket'] = {
      write: () => {
        writes += 1
        return !backedUp
      },
      once: (event, listener) => {
        if (event === 'drain') {
          drains.add(listener)
        }
        return socket
      },
      off: (event, listener) => {
        drains.delete(listener)
        return socket
      },
      destroyed: false,
      get writableNeedDrain() {
        return backedUp
      }
    }
    const attachment = new ProviderRelayAttachment('app', { socket }, 'r-1', () => {})
    attachment.whilePaused(true, () => 7)
    // 100 minutes at a stalled client: nothing asked, no timer left polling, one drain wait.
    vi.advanceTimersByTime(100 * 60_000)
    expect(writes).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
    expect(drains.size).toBe(1)
    backedUp = false
    for (const drain of [...drains]) {
      drains.delete(drain)
      drain()
    }
    expect(writes).toBe(1)
    attachment.release()
    expect(vi.getTimerCount()).toBe(0)
    expect(drains.size).toBe(0)
  })
})
