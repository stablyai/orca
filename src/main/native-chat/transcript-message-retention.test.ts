import { describe, expect, it } from 'vitest'
import type { NativeChatMessage } from '../../shared/native-chat-types'
import {
  MAX_NATIVE_CHAT_TRANSCRIPT_RETAINED_BYTES,
  TranscriptMessageRetention
} from './transcript-message-retention'

function message(id: string): NativeChatMessage {
  return {
    id,
    role: 'user',
    blocks: [{ type: 'text', text: id }],
    timestamp: null,
    source: 'transcript'
  }
}

describe('TranscriptMessageRetention', () => {
  it('keeps the newest messages within both count and byte budgets', () => {
    const retention = new TranscriptMessageRetention(2, 600)

    retention.add(message('one'), 10)
    retention.add(message('two'), 10)
    retention.add(message('three'), 10)

    expect(retention.values().map(({ id }) => id)).toEqual(['two', 'three'])
    expect(retention.size).toBe(2)
    expect(retention.retainedBytes).toBeLessThanOrEqual(600)
  })

  it('applies the production 64 MiB policy without retaining older oversized history', () => {
    const retention = new TranscriptMessageRetention()
    const sourceBytes = 2 * 1024 * 1024

    for (let index = 0; index < 17; index += 1) {
      retention.add(message(`message-${index}`), sourceBytes)
    }

    expect(retention.values().map(({ id }) => id)).toEqual(
      Array.from({ length: 15 }, (_unused, index) => `message-${index + 2}`)
    )
    expect(retention.retainedBytes).toBeLessThanOrEqual(MAX_NATIVE_CHAT_TRANSCRIPT_RETAINED_BYTES)
  })
})
