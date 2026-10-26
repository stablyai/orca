import { describe, expect, it } from 'vitest'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import { rebaseMobileNativeChatPendingBaselines } from './mobile-native-chat-pending-baseline'
import type { MobileNativeChatPendingMessage } from './native-chat/mobile-native-chat-pending-echo'

function userTurn(id: string, text: string, timestamp: number): NativeChatMessage {
  return { id, role: 'user', blocks: [{ type: 'text', text }], timestamp, source: 'transcript' }
}

function assistantTurn(id: string, text: string, timestamp: number): NativeChatMessage {
  return {
    id,
    role: 'assistant',
    blocks: [{ type: 'text', text }],
    timestamp,
    source: 'transcript'
  }
}

function unresolved(
  id: string,
  text: string,
  expectedOccurrence = 1
): MobileNativeChatPendingMessage {
  return { id, text, expectedOccurrence, baselineTailMessageId: null, baselineResolved: false }
}

describe('rebaseMobileNativeChatPendingBaselines', () => {
  const history = [userTurn('m1', 'run the tests', 1000), assistantTurn('m2', 'passed', 1100)]

  it('returns the same array when every baseline is already resolved', () => {
    const pending: MobileNativeChatPendingMessage[] = [
      {
        id: 'p1',
        text: 'hi',
        expectedOccurrence: 1,
        baselineTailMessageId: 'm2',
        baselineResolved: true
      }
    ]
    expect(rebaseMobileNativeChatPendingBaselines(history, pending)).toBe(pending)
  })

  it('gives an unresolved send the loaded tail as its glue boundary', () => {
    expect(
      rebaseMobileNativeChatPendingBaselines(history, [unresolved('p1', 'run the tests')])
    ).toEqual([
      {
        id: 'p1',
        text: 'run the tests',
        // Do not recount a read that may already contain this send’s echo.
        expectedOccurrence: 1,
        baselineTailMessageId: 'm2',
        baselineResolved: true
      }
    ])
  })

  it('pins to null when the authoritative transcript is empty', () => {
    expect(rebaseMobileNativeChatPendingBaselines([], [unresolved('p1', 'hi')])).toEqual([
      {
        id: 'p1',
        text: 'hi',
        expectedOccurrence: 1,
        baselineTailMessageId: null,
        baselineResolved: true
      }
    ])
  })

  it('keeps the ordinals the queue already assigned', () => {
    expect(
      rebaseMobileNativeChatPendingBaselines(history, [
        unresolved('p1', 'run the tests', 1),
        unresolved('p2', 'run the tests', 2)
      ]).map((item) => item.expectedOccurrence)
    ).toEqual([1, 2])
  })

  it('leaves already-resolved neighbours untouched', () => {
    const resolved: MobileNativeChatPendingMessage = {
      id: 'p1',
      text: 'run the tests',
      expectedOccurrence: 9,
      baselineTailMessageId: 'm1',
      baselineResolved: true
    }
    const rebased = rebaseMobileNativeChatPendingBaselines(history, [
      resolved,
      unresolved('p2', 'run the tests', 2)
    ])
    expect(rebased[0]).toBe(resolved)
    expect(rebased[1]).toEqual({
      id: 'p2',
      text: 'run the tests',
      expectedOccurrence: 2,
      baselineTailMessageId: 'm2',
      baselineResolved: true
    })
  })

  it('never moves a tail the send actually captured', () => {
    const captured: MobileNativeChatPendingMessage = {
      id: 'p1',
      text: 'run the tests',
      expectedOccurrence: 1,
      baselineTailMessageId: 'm1',
      baselineResolved: false
    }
    const rebased = rebaseMobileNativeChatPendingBaselines(history, [captured])
    expect(rebased[0]?.baselineTailMessageId).toBe('m1')
    expect(rebased[0]?.baselineResolved).toBe(true)
  })

  it('keeps a caption-less image echo on the tail it actually captured', () => {
    const images = {
      ...unresolved('p1', ''),
      baselineTailMessageId: 'm1',
      images: ['file:///a.png']
    }
    const rebased = rebaseMobileNativeChatPendingBaselines(history, [images])
    expect(rebased[0]?.baselineTailMessageId).toBe('m1')
    expect(rebased[0]?.expectedOccurrence).toBe(1)
    expect(rebased[0]?.baselineResolved).toBe(true)
  })

  it('leaves a captioned image echo entirely alone', () => {
    const rebased = rebaseMobileNativeChatPendingBaselines(history, [
      { ...unresolved('p1', 'here'), images: ['file:///a.png'] }
    ])
    expect(rebased[0]?.baselineTailMessageId).toBe(null)
    expect(rebased[0]?.expectedOccurrence).toBe(1)
    expect(rebased[0]?.baselineResolved).toBe(true)
  })

  it('never supplies a tail to a caption-less image echo either', () => {
    const rebased = rebaseMobileNativeChatPendingBaselines(history, [
      { ...unresolved('p1', ''), images: ['file:///a.png'] },
      { ...unresolved('p2', '', 2), images: ['file:///b.png'] }
    ])
    expect(rebased.map((item) => item.baselineTailMessageId)).toEqual([null, null])
    expect(rebased.map((item) => item.expectedOccurrence)).toEqual([1, 2])
    expect(rebased.every((item) => item.baselineResolved)).toBe(true)
  })

  it('never supplies a tail to a text-empty entry', () => {
    const rebased = rebaseMobileNativeChatPendingBaselines(history, [unresolved('p1', '   ')])
    expect(rebased[0]?.baselineTailMessageId).toBe(null)
    expect(rebased[0]?.baselineResolved).toBe(true)
  })
})
