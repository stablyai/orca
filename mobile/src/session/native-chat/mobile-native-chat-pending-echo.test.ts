import { expect, it, vi } from 'vitest'
import * as legacyProof from '../../../../src/shared/native-chat/transcript/native-chat-pending-occurrence'
import * as desktopWitnesses from '../../../../src/shared/native-chat/transcript/native-chat-pending-witnesses'
import type { NativeChatMessage } from '../../../../src/shared/native-chat/native-chat-types'
import { mobileNativeChatDraftDestination } from './composer/mobile-native-chat-draft-inputs'
import {
  appendMobileNativeChatPending,
  mergeWaitingSessionPending,
  retireLandedMobileNativeChatPending,
  visibleMobileNativeChatPending,
  mobileNativeChatPendingAsMessages,
  type MobileNativeChatPendingMessage,
  type MobileNativeChatSendOrigin
} from './transcript/mobile-native-chat-pending-echo'

it('retains a landed echo through an empty read until a reply advances it', () => {
  const pending = [{ id: 'send', text: 'hello', sentAt: 100, afterMessageId: null }]
  const user: NativeChatMessage = {
    id: 'u',
    role: 'user',
    timestamp: 101,
    source: 'transcript',
    blocks: [{ type: 'text', text: 'hello' }]
  }
  const landed = retireLandedMobileNativeChatPending([user], pending, new Set())
  expect(landed.map((entry) => entry.id)).toEqual(['send'])
  const empty = retireLandedMobileNativeChatPending([], landed, new Set())
  expect(empty.map((entry) => entry.id)).toEqual(['send'])
  const reply: NativeChatMessage = {
    ...user,
    id: 'a',
    role: 'assistant',
    timestamp: 102,
    blocks: []
  }
  expect(retireLandedMobileNativeChatPending([user, reply], empty, new Set())).toEqual([])
})

it.each([16, 160])('reconciles %i migrated phone echoes without desktop allocation', (size) => {
  const subset = vi.spyOn(desktopWitnesses, 'nativeChatPendingWitnesses')
  const glue = vi.spyOn(legacyProof, 'selectPendingIndicesRepresentedByUserRows')
  try {
    let session: Record<string, MobileNativeChatPendingMessage[]> = {}
    const origin: MobileNativeChatSendOrigin = {
      draftKey: 'draft',
      draftDestination: mobileNativeChatDraftDestination('cardinality-test'),
      draftEditGeneration: 0,
      pendingKey: null,
      normalizedText: '',
      boundary: { afterMessageId: 'missing', afterMessageTimestamp: 0 },
      sentAt: 1
    }
    for (let start = 0; start < size; start += 8) {
      let waiting: Record<string, MobileNativeChatPendingMessage[]> = {}
      for (let index = start; index < start + 8; index++) {
        waiting = appendMobileNativeChatPending(
          waiting,
          'draft',
          `send-${index}`,
          origin,
          `caption-${index}`,
          [`file:///p-${index}.png`]
        )
      }
      session = mergeWaitingSessionPending(session, 'session', waiting.draft)
    }
    const pending = session.session
    let contentReads = 0
    let eligibilityReads = 0
    const rows = Array.from({ length: 24 }, (_, index): NativeChatMessage => ({
      id: `unrelated-${index}`,
      role: 'user',
      source: 'transcript',
      get timestamp() {
        eligibilityReads++
        return 2
      },
      get blocks(): NativeChatMessage['blocks'] {
        contentReads++
        return [{ type: 'text', text: 'unrelated' }]
      }
    }))
    expect(visibleMobileNativeChatPending(rows, pending)).toHaveLength(size)
    expect(retireLandedMobileNativeChatPending(rows, pending, new Set())).toHaveLength(size)
    expect(mobileNativeChatPendingAsMessages(pending, rows)).toHaveLength(size)
    // The immutable snapshot normalizes each eligible row once across list, retirement and status.
    expect(contentReads).toBeLessThanOrEqual(24)
    expect(eligibilityReads).toBeLessThanOrEqual(6 * (size + 1) * rows.length)
    expect(glue.mock.calls.length).toBeLessThanOrEqual(2)
    expect(subset).not.toHaveBeenCalled()
    const landed = pending.map((entry, index): NativeChatMessage => ({
      id: `landed-${index}`,
      role: 'user',
      source: 'transcript',
      timestamp: 3,
      blocks: [{ type: 'text', text: entry.text }]
    }))
    expect(visibleMobileNativeChatPending(landed, pending)).toHaveLength(size)
    expect(
      retireLandedMobileNativeChatPending(
        [
          ...landed,
          { id: 'reply', role: 'assistant', source: 'transcript', timestamp: 4, blocks: [] }
        ],
        pending,
        new Set(pending.map((entry) => entry.id))
      )
    ).toEqual([])
  } finally {
    subset.mockRestore()
    glue.mockRestore()
  }
})

it('keeps the phone visibility and advancement glue residuals distinct', () => {
  const boundary: NativeChatMessage = {
    id: 'b',
    role: 'assistant',
    timestamp: 1,
    source: 'transcript',
    blocks: []
  }
  const pending = [
    { id: 'c', text: 'first', sentAt: 2, afterMessageId: 'b' },
    { id: 'd', text: 'second', sentAt: 2, afterMessageId: 'b' }
  ]
  const rows: NativeChatMessage[] = [
    boundary,
    {
      id: 'x',
      role: 'user',
      timestamp: 3,
      source: 'transcript',
      blocks: [{ type: 'text', text: 'first second' }]
    },
    { ...boundary, id: 'a', timestamp: 4 },
    {
      id: 'y',
      role: 'user',
      timestamp: 5,
      source: 'transcript',
      blocks: [{ type: 'text', text: 'first' }]
    }
  ]
  expect(visibleMobileNativeChatPending(rows, pending).map((entry) => entry.id)).toEqual(['d'])
  expect(retireLandedMobileNativeChatPending(rows, pending, new Set())).toEqual([])
})

it('hides a continued phone prompt until its later reply permits retirement', () => {
  const boundary: NativeChatMessage = {
    id: 'b',
    role: 'assistant',
    timestamp: 1,
    source: 'transcript',
    blocks: []
  }
  const pending = [{ id: 'c', text: 'first\\', sentAt: 2, afterMessageId: 'b' }]
  const user: NativeChatMessage = {
    id: 'x',
    role: 'user',
    timestamp: 3,
    source: 'transcript',
    blocks: [{ type: 'text', text: 'first outside' }]
  }
  const rows = [boundary, user]
  expect(visibleMobileNativeChatPending(rows, pending)).toEqual([])
  const kept = retireLandedMobileNativeChatPending(rows, pending, new Set())
  expect(kept.map((entry) => entry.id)).toEqual(['c'])
  expect(retireLandedMobileNativeChatPending([], kept, new Set())).toEqual(kept)
  expect(
    retireLandedMobileNativeChatPending(
      [...rows, { ...boundary, id: 'reply', timestamp: 4 }],
      kept,
      new Set()
    )
  ).toEqual([])
})
