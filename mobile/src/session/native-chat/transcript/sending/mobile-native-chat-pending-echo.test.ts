import { describe, expect, it } from 'vitest'
import { findLandedImagePreviewEchoes } from '../../composer/drafts/mobile-native-chat-draft-reconcile'
import {
  retireLandedMobileNativeChatPending,
  visibleMobileNativeChatPending
} from './mobile-native-chat-pending-echo'
import { assignNativeChatPendingOccurrence } from '../../../../../../src/shared/native-chat/transcript/pending-sends/native-chat-pending-occurrence'
import type { NativeChatMessage } from '../../../../../../src/shared/native-chat/native-chat-types'
const note = '[Image source file: "/repo/a.png"; attached viewing copy: "/temp/a.png"]'
function message(
  id: string,
  role: 'user' | 'assistant',
  text: string,
  timestamp: number
): NativeChatMessage {
  return { id, role, timestamp, source: 'transcript', blocks: [{ type: 'text', text }] }
}
const row = (id: string, text: string, paths: string[], at: number): NativeChatMessage => ({
  ...message(id, 'user', text, at),
  blocks: [...paths.map((path) => ({ type: 'image-ref' as const, path })), { type: 'text', text }]
})
describe('mobile source-note preview ownership', () => {
  it('keeps mobile attachment evidence between preview binding and assistant advancement', () => {
    const pending = [
      {
        id: 'phone',
        text: note,
        images: ['file://preview.png'],
        sentAt: 100,
        afterMessageId: 'boundary'
      }
    ]
    const transcript = [
      message('boundary', 'assistant', 'ready', 90),
      row('phone-row', note, ['/repo/small.png'], 120)
    ]
    const landed = findLandedImagePreviewEchoes(transcript, pending)
    expect(landed.map((entry) => entry.pendingId)).toEqual(['phone'])
    const remaining = retireLandedMobileNativeChatPending(transcript, pending, new Set(['phone']))
    expect(visibleMobileNativeChatPending(transcript, remaining, new Set(['phone']))).toEqual([])
    transcript.push(message('reply', 'assistant', 'done', 130))
    expect(retireLandedMobileNativeChatPending(transcript, remaining, new Set(['phone']))).toEqual(
      []
    )
  })
  it('binds repeated note captions against the same attachment-count groups as assignment', () => {
    const first = {
      id: 'one',
      text: note,
      images: ['preview-one'],
      sentAt: 100,
      afterMessageId: 'boundary'
    }
    const second = assignNativeChatPendingOccurrence([first], {
      id: 'two',
      text: note,
      images: ['preview-two-a', 'preview-two-b'],
      sentAt: 110,
      afterMessageId: 'boundary'
    })
    const transcript = [
      message('boundary', 'assistant', 'ready', 90),
      row('one-row', note, ['/repo/small-1.png'], 120),
      message('reply', 'assistant', 'done', 130),
      row('two-row', note, ['/repo/small-2.png', '/repo/small-3.png'], 140),
      message('reply2', 'assistant', 'done', 150)
    ]
    expect(
      findLandedImagePreviewEchoes(transcript, [first, second]).map((entry) => [
        entry.pendingId,
        entry.messageId
      ])
    ).toEqual([
      ['one', 'one-row'],
      ['two', 'two-row']
    ])
    expect(
      findLandedImagePreviewEchoes(transcript, [second]).map((entry) => entry.messageId)
    ).toEqual(['two-row'])
  })
})
