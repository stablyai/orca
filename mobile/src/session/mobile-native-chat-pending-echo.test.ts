import { describe, expect, it } from 'vitest'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import {
  countUserTextOccurrences,
  normalizeReconcileText
} from './mobile-native-chat-draft-reconcile'
import {
  appendMobileNativeChatPending,
  type MobileNativeChatSendOrigin
} from './mobile-native-chat-pending-echo'
import { retireLandedMobileNativeChatPending } from './mobile-native-chat-pending-retirement'

const NO_IMAGE_ECHOES: ReadonlySet<string> = new Set()

/** A send captured against `messages`, exactly as `captureSendOrigin` builds it. */
function sendOrigin(
  text: string,
  messages: readonly NativeChatMessage[]
): MobileNativeChatSendOrigin {
  const normalizedText = normalizeReconcileText(text)
  return {
    draftKey: 'host\0worktree\0tab',
    draftEditGeneration: 0,
    pendingKey: 'host\0worktree\0tab\0session',
    normalizedText,
    // Use production's counter so the test cannot mirror its normalization drift.
    baselineOccurrences: countUserTextOccurrences(messages, normalizedText),
    baselineTailMessageId: messages.at(-1)?.id ?? null,
    baselineResolved: true
  }
}

function userTurn(id: string, text: string): NativeChatMessage {
  return {
    id,
    role: 'user',
    blocks: [{ type: 'text', text }],
    timestamp: 1000,
    source: 'transcript'
  }
}

describe('appendMobileNativeChatPending ordinals for repeated sends', () => {
  // Multi-line text distinguishes raw trim from reconciliation normalization.
  const MULTILINE = 'first line of the prompt\nsecond line of the prompt'

  it('gives a repeated multi-line send the next ordinal', () => {
    const baseline = [userTurn('m1', 'unrelated')]
    const first = appendMobileNativeChatPending(
      [],
      'p1',
      sendOrigin(MULTILINE, baseline),
      MULTILINE
    )
    const both = appendMobileNativeChatPending(
      first,
      'p2',
      sendOrigin(MULTILINE, baseline),
      MULTILINE
    )

    expect(both.map((item) => item.expectedOccurrence)).toEqual([1, 2])
  })

  it('retires only the first echo when the first of two identical rows lands', () => {
    const baseline = [userTurn('m1', 'unrelated')]
    const pending = appendMobileNativeChatPending(
      appendMobileNativeChatPending([], 'p1', sendOrigin(MULTILINE, baseline), MULTILINE),
      'p2',
      sendOrigin(MULTILINE, baseline),
      MULTILINE
    )
    const landedOnce = [...baseline, userTurn('m2', MULTILINE)]

    expect(
      retireLandedMobileNativeChatPending(landedOnce, pending, NO_IMAGE_ECHOES).map(
        (item) => item.id
      )
    ).toEqual(['p2'])
  })

  it('still counts a single-line repeat, which never regressed', () => {
    const baseline = [userTurn('m1', 'unrelated')]
    const both = appendMobileNativeChatPending(
      appendMobileNativeChatPending([], 'p1', sendOrigin('ping', baseline), 'ping'),
      'p2',
      sendOrigin('ping', baseline),
      'ping'
    )

    expect(both.map((item) => item.expectedOccurrence)).toEqual([1, 2])
  })
})

describe('mobile pending echoes whose text normalizes to nothing', () => {
  // KNOWN GAP: marker-only rows render empty; suppressing their echo would hide the send.
  it('cannot retire an echo whose row normalizes away', () => {
    const stranded = [
      {
        id: 'p1',
        text: '[Image #1]',
        expectedOccurrence: 1,
        baselineTailMessageId: 'm1',
        baselineResolved: true
      }
    ]
    const landed = [userTurn('m1', 'hi'), userTurn('m2', '[Image #1]')]

    expect(retireLandedMobileNativeChatPending(landed, stranded, NO_IMAGE_ECHOES)).toEqual(stranded)
  })

  it('gives a caption-less photo its own ordinal after a marker-only caption', () => {
    const first = appendMobileNativeChatPending(
      [],
      'p1',
      sendOrigin('[Image #1]', []),
      '[Image #1]',
      ['file:///a.jpg']
    )
    const both = appendMobileNativeChatPending(first, 'p2', sendOrigin('', []), '', [
      'file:///b.jpg'
    ])

    expect(both.map((item) => item.expectedOccurrence)).toEqual([1, 2])
  })

  it('records an image echo, whose text is empty by design', () => {
    const pending = appendMobileNativeChatPending([], 'p1', sendOrigin('', []), '', [
      'file:///photo.jpg'
    ])

    expect(pending).toHaveLength(1)
    expect(pending[0]?.expectedOccurrence).toBe(1)
  })
})
