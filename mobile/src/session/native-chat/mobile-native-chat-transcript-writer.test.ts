import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NativeChatMessage } from '../../../../src/shared/native-chat/native-chat-types'
import { publishPageDeviceStore } from '../../mobile-web-shell/bridge/page-device-store'
import { emitPageAppInactive } from '../../mobile-web-shell/bridge/bridge-app-inactive'
import { noteChatTranscript } from './mobile-native-chat-transcript-writer'

function message(id: string): NativeChatMessage {
  return {
    id,
    role: 'assistant',
    blocks: [{ type: 'text', text: id }],
    timestamp: 1,
    source: 'transcript'
  }
}

describe('chat copies when the app leaves the foreground', () => {
  const writes: string[] = []

  beforeEach(() => {
    writes.length = 0
    publishPageDeviceStore({
      available: () => true,
      read: async (_table, keys) => ({ status: 'ok', values: keys.map(() => null) }),
      write: async (_table, ops) => {
        writes.push(...ops.map((op) => op.key))
        return { written: true }
      }
    })
  })

  afterEach(() => {
    vi.useRealTimers()
    publishPageDeviceStore(null)
  })

  function note(rows: NativeChatMessage[]): void {
    noteChatTranscript(
      'chat-leaving',
      rows,
      () => true,
      (savedAt) => ({
        kind: 'terminal',
        savedAt,
        messages: rows,
        hasMore: false,
        beforeOffset: null
      })
    )
  }

  it('saves new rows on leaving and writes nothing when a flap brings none', async () => {
    vi.useFakeTimers()
    const [m1, m2, m3] = [message('m1'), message('m2'), message('m3')]
    note([m1, m2, m3])
    emitPageAppInactive()
    await vi.runAllTimersAsync()
    expect(writes).toHaveLength(1)

    // Two minutes later, Notification Centre and back: the rows on screen are a new list with the same rows.
    vi.setSystemTime(Date.now() + 120_000)
    note([m1, m2, m3])
    emitPageAppInactive()
    note([m1, m2, m3])
    emitPageAppInactive()
    await vi.runAllTimersAsync()
    expect(writes).toHaveLength(1)

    // A middle row changed (a tool result landed), with the last row the same.
    note([m1, { ...m2, blocks: [{ type: 'text', text: 'm2 with its result' }] }, m3])
    emitPageAppInactive()
    await vi.runAllTimersAsync()
    expect(writes).toHaveLength(2)
  })
})
