// Guards #51086 (bot chats now relay too): a relay paused at its cap asks its client for acks on a
// backoff, and asks nothing while the client's stream is backed up, however long that lasts.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ProviderRelayAttachment, type ProviderRelayStream } from './provider-relay-attachment'

afterEach(() => {
  vi.useRealTimers()
})

describe('paused relay ack nudges', () => {
  it('stop while the client is backed up, and resume once it reads', () => {
    vi.useFakeTimers()
    let backedUp = true
    let writes = 0
    const socket: ProviderRelayStream['socket'] = {
      write: () => {
        writes += 1
        return !backedUp
      },
      once: () => socket,
      off: () => socket,
      destroyed: false,
      get writableNeedDrain() {
        return backedUp
      }
    }
    const attachment = new ProviderRelayAttachment('app', { socket }, 'r-1', () => {})
    attachment.whilePaused(true, () => 7)
    // 100 minutes of backoff nudges at a stalled client queue nothing.
    vi.advanceTimersByTime(100 * 60_000)
    expect(writes).toBe(0)
    backedUp = false
    vi.advanceTimersByTime(30_000)
    expect(writes).toBe(1)
    attachment.release()
    expect(vi.getTimerCount()).toBe(0)
  })
})
