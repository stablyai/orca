import { describe, expect, it } from 'vitest'
import type { NativeChatMessage } from '../../../../../../src/shared/native-chat/native-chat-types'
import { buildMobileNativeChatTransientData } from '../../transcript/projection/mobile-native-chat-render-data'
import { findLandedImagePreviewEchoes } from './mobile-native-chat-draft-reconcile'
import {
  retireLandedMobileNativeChatPending,
  visibleMobileNativeChatPending
} from '../../transcript/sending/mobile-native-chat-pending-echo'

const first = '/data/agent-session-attachments/0b3f5c2a-1d4e-4a6b-9c8d-7e6f5a4b3c2d/a.json'
const second = '/data/agent-session-attachments/1c4e6d3b-2e5f-4b7c-8d9e-8f7a6b5c4d3e/b.json'

const sent: NativeChatMessage = {
  id: 'row-1',
  role: 'user',
  blocks: [{ type: 'text', text: `${first} ${second} Files test` }],
  timestamp: 1,
  source: 'transcript'
}

describe('a terminal chat file send and its local echo', () => {
  it('lands the echo on the confirmed row even though that row also carries the stored paths', () => {
    const landed = findLandedImagePreviewEchoes(
      [sent],
      [
        {
          id: 'echo-1',
          text: 'Files test',
          sentAt: 1,
          afterMessageId: null,
          matchingOccurrence: 1,
          images: [first, second]
        }
      ]
    )
    expect(landed).toEqual([{ pendingId: 'echo-1', messageId: 'row-1', images: [first, second] }])
  })

  it('does not land a textless echo on a row that carries different uploaded files', () => {
    const other: NativeChatMessage = {
      id: 'row-2',
      role: 'user',
      blocks: [{ type: 'text', text: second }],
      timestamp: 2,
      source: 'transcript'
    }
    const landed = findLandedImagePreviewEchoes(
      [other],
      [
        {
          id: 'echo-1',
          text: '',
          sentAt: 1,
          afterMessageId: null,
          matchingOccurrence: 1,
          images: [first]
        }
      ]
    )
    expect(landed).toEqual([])
  })

  it('does not add a second chip for a file the row text already names', () => {
    const { folded } = buildMobileNativeChatTransientData({
      folded: [sent],
      streaming: null,
      pending: [],
      imagePreviewsByMessageId: { 'row-1': [first, second] }
    })
    expect(folded[0]?.blocks.map((block) => block.type)).toEqual(['text'])
  })
})

describe('a terminal chat file send with spaces in the stored path', () => {
  const spaced =
    '/Users/me/Library/Application Support/orca/agent-session-attachments/0b3f5c2a-1d4e-4a6b-9c8d-7e6f5a4b3c2d/a.json'
  const spacedToo =
    '/Users/me/Library/Application Support/orca/agent-session-attachments/1c4e6d3b-2e5f-4b7c-8d9e-8f7a6b5c4d3e/b.json'
  const escape = (path: string): string => path.replace(/ /g, '\\ ')
  const row: NativeChatMessage = {
    id: 'row-1',
    role: 'user',
    blocks: [{ type: 'text', text: `${escape(spaced)} ${escape(spacedToo)}  Files` }],
    timestamp: 1,
    source: 'transcript'
  }
  const reply: NativeChatMessage = {
    id: 'reply-1',
    role: 'assistant',
    blocks: [{ type: 'text', text: 'ok' }],
    timestamp: 2,
    source: 'transcript'
  }
  const echo = {
    id: 'echo-1',
    text: 'Files',
    sentAt: 1,
    afterMessageId: null,
    matchingOccurrence: 1,
    images: [spaced, spacedToo]
  }

  it('leaves no echo behind once the confirmed row lands, before or after the reply', () => {
    for (const rows of [[row], [row, reply]]) {
      const landed = findLandedImagePreviewEchoes(rows, [echo])
      const kept = retireLandedMobileNativeChatPending(
        rows,
        [echo],
        new Set(landed.map((entry) => entry.pendingId))
      )
      expect(visibleMobileNativeChatPending(rows, kept)).toEqual([])
      if (rows.length > 1) {
        expect(kept).toEqual([])
      }
    }
  })
})

describe('a terminal chat file send from a Windows host', () => {
  const store = 'C:\\Users\\u\\AppData\\Roaming\\orca\\agent-session-attachments'
  const bare = `${store}\\0b3f5c2a-1d4e-4a6b-9c8d-7e6f5a4b3c2d\\movie.mp4`
  const spaced = `${store}\\1c4e6d3b-2e5f-4b7c-8d9e-8f7a6b5c4d3e\\My Notes.txt`
  const row: NativeChatMessage = {
    id: 'row-1',
    role: 'user',
    blocks: [{ type: 'text', text: `${bare} "${spaced}"  Files` }],
    timestamp: 1,
    source: 'transcript'
  }
  const echo = {
    id: 'echo-1',
    text: 'Files',
    sentAt: 1,
    afterMessageId: null,
    matchingOccurrence: 1,
    images: [bare, spaced]
  }

  it('leaves no echo behind once the confirmed row lands', () => {
    const landed = findLandedImagePreviewEchoes([row], [echo])
    expect(landed).toEqual([{ pendingId: 'echo-1', messageId: 'row-1', images: [bare, spaced] }])
    const kept = retireLandedMobileNativeChatPending(
      [row],
      [echo],
      new Set(landed.map((entry) => entry.pendingId))
    )
    expect(visibleMobileNativeChatPending([row], kept)).toEqual([])
  })
})
