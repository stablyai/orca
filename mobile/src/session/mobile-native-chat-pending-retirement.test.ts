import { describe, expect, it, vi } from 'vitest'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import type { MobileNativeChatPendingMessage } from './mobile-native-chat-pending-echo'
import {
  GLUE_SLIDE_BUDGET,
  retireLandedMobileNativeChatPending,
  selectGluedPendingIds
} from './mobile-native-chat-pending-retirement'

const NO_IMAGE_ECHOES: ReadonlySet<string> = new Set()

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

/** A send captured with `tail` as the last transcript message it could see. */
function pendingSend(
  id: string,
  text: string,
  tail: string | null,
  expectedOccurrence = 1,
  baselineResolved = true
): MobileNativeChatPendingMessage {
  return { id, text, expectedOccurrence, baselineTailMessageId: tail, baselineResolved }
}

function retiredIds(
  messages: readonly NativeChatMessage[],
  pending: readonly MobileNativeChatPendingMessage[]
): string[] {
  return [...selectGluedPendingIds(messages, pending)].sort()
}

describe('selectGluedPendingIds', () => {
  it('retires both bubbles when two rapid sends collapse into one user row', () => {
    const messages = [
      assistantTurn('m1', 'ready', 1000),
      userTurn('m2', 'run the tests again', 5000)
    ]
    const pending = [pendingSend('p1', 'run the tests', 'm1'), pendingSend('p2', 'again', 'm1')]
    expect(retiredIds(messages, pending)).toEqual(['p1', 'p2'])
  })

  it('retires a glued row that concatenated with no separator at all', () => {
    const messages = [
      assistantTurn('m1', 'ready', 1000),
      userTurn('m2', 'run the testsagain', 5000)
    ]
    const pending = [pendingSend('p1', 'run the tests', 'm1'), pendingSend('p2', 'again', 'm1')]
    expect(retiredIds(messages, pending)).toEqual(['p1', 'p2'])
  })

  it('retires three collapsed prompts in one row', () => {
    const messages = [assistantTurn('m1', 'ready', 1000), userTurn('m2', 'one two three', 5000)]
    const pending = [
      pendingSend('p1', 'one', 'm1'),
      pendingSend('p2', 'two', 'm1'),
      pendingSend('p3', 'three', 'm1')
    ]
    expect(retiredIds(messages, pending)).toEqual(['p1', 'p2', 'p3'])
  })

  it('matches across tab, newline and repeated-space separators', () => {
    const messages = [
      assistantTurn('m1', 'ready', 1000),
      userTurn('m2', 'run the tests\t\n  again', 5000)
    ]
    const pending = [
      pendingSend('p1', ' run the tests\n', 'm1'),
      pendingSend('p2', '\tagain ', 'm1')
    ]
    expect(retiredIds(messages, pending)).toEqual(['p1', 'p2'])
  })

  it('matches prompts that themselves contain the separator', () => {
    const messages = [
      assistantTurn('m1', 'ready', 1000),
      userTurn('m2', 'fix the bug and run the tests', 5000)
    ]
    const pending = [
      pendingSend('p1', 'fix the bug', 'm1'),
      pendingSend('p2', 'and run the tests', 'm1')
    ]
    expect(retiredIds(messages, pending)).toEqual(['p1', 'p2'])
  })

  it('matches when one pending is a strict prefix of the next', () => {
    const messages = [assistantTurn('m1', 'ready', 1000), userTurn('m2', 'run run the tests', 5000)]
    const pending = [pendingSend('p1', 'run', 'm1'), pendingSend('p2', 'run the tests', 'm1')]
    expect(retiredIds(messages, pending)).toEqual(['p1', 'p2'])
  })

  it('matches identical prompts sent twice and three times', () => {
    const twice = [assistantTurn('m1', 'ready', 1000), userTurn('m2', 'hi hi', 5000)]
    expect(
      retiredIds(twice, [pendingSend('p1', 'hi', 'm1', 1), pendingSend('p2', 'hi', 'm1', 2)])
    ).toEqual(['p1', 'p2'])

    const thrice = [assistantTurn('m1', 'ready', 1000), userTurn('m2', 'hi hi hi', 5000)]
    expect(
      retiredIds(thrice, [
        pendingSend('p1', 'hi', 'm1', 1),
        pendingSend('p2', 'hi', 'm1', 2),
        pendingSend('p3', 'hi', 'm1', 3)
      ])
    ).toEqual(['p1', 'p2', 'p3'])
  })

  it('retires two separate glued rows against their own runs', () => {
    const messages = [
      assistantTurn('m1', 'ready', 1000),
      userTurn('m2', 'one two', 5000),
      userTurn('m3', 'three four', 6000)
    ]
    const pending = [
      pendingSend('p1', 'one', 'm1'),
      pendingSend('p2', 'two', 'm1'),
      pendingSend('p3', 'three', 'm2'),
      pendingSend('p4', 'four', 'm2')
    ]
    expect(retiredIds(messages, pending)).toEqual(['p1', 'p2', 'p3', 'p4'])
  })

  // FP1: the concatenation already exists in history, older than the sends.
  it('never lets a transcript row that predates the sends retire them', () => {
    const messages = [
      userTurn('m1', 'run the tests again', 1),
      assistantTurn('m2', 'done', 2),
      assistantTurn('m3', 'anything else?', 3)
    ]
    const pending = [pendingSend('p1', 'run the tests', 'm3'), pendingSend('p2', 'again', 'm3')]
    expect(retiredIds(messages, pending)).toEqual([])
  })

  // FP2: an old turn reads like the concatenation of two much later sends.
  it('never lets an older turn retire sends captured after it', () => {
    const messages = [userTurn('m1', 'fix the bug', 1000), assistantTurn('m2', 'fixed', 1100)]
    const pending = [pendingSend('p1', 'fix the', 'm2'), pendingSend('p2', 'bug', 'm2')]
    expect(retiredIds(messages, pending)).toEqual([])
  })

  it('rejects a row the pending run only prefixes', () => {
    const messages = [
      assistantTurn('m1', 'ready', 1000),
      userTurn('m2', 'run the tests again with coverage', 5000)
    ]
    const pending = [pendingSend('p1', 'run the tests', 'm1'), pendingSend('p2', 'again', 'm1')]
    expect(retiredIds(messages, pending)).toEqual([])
  })

  it('rejects a run that only partly spells the row', () => {
    const messages = [assistantTurn('m1', 'ready', 1000), userTurn('m2', 'run the tests', 5000)]
    const pending = [pendingSend('p1', 'run the tests', 'm1'), pendingSend('p2', 'again', 'm1')]
    // A lone exact match is an ordinary landing, not glue.
    expect(retiredIds(messages, pending)).toEqual([])
  })

  it('rejects glue when a send in the run cannot resolve its own tail', () => {
    const messages = [assistantTurn('m1', 'ready', 1000), userTurn('m2', 'one two', 5000)]
    const pending = [pendingSend('p1', 'one', 'm1'), pendingSend('p2', 'two', 'paginated-away')]
    expect(retiredIds(messages, pending)).toEqual([])
  })

  it('treats a null tail as "transcript was empty", so any row can glue', () => {
    const messages = [userTurn('m1', 'one two', 5000)]
    const pending = [pendingSend('p1', 'one', null), pendingSend('p2', 'two', null)]
    expect(retiredIds(messages, pending)).toEqual(['p1', 'p2'])
  })

  // Unresolved baselines are held out of matching until the drafts hook rebases
  // them onto the first authoritative read — see mobile-native-chat-pending-baseline.
  it('holds out sends whose baseline has not been rebased onto a real transcript', () => {
    const messages = [userTurn('m1', 'one two', 1000)]
    const pending = [
      pendingSend('p1', 'one', null, 1, false),
      pendingSend('p2', 'two', null, 1, false)
    ]
    expect(retiredIds(messages, pending)).toEqual([])
  })

  // A head that can never match must not freeze the run behind it: one stuck
  // bubble would otherwise disable glue retirement for the rest of the session.
  it('glues a later pair even when the head of the run can never match', () => {
    const messages = [
      userTurn('m0', 'unrelated', 1000),
      userTurn('m1', 'fix the bug', 5000),
      userTurn('m2', 'ship the fix', 6000)
    ]
    const stuckHead = pendingSend('p0', 'bug', 'm0')
    const pair = [pendingSend('p1', 'ship the', 'm0'), pendingSend('p2', 'fix', 'm0')]
    expect(retiredIds(messages, [stuckHead, ...pair])).toEqual(['p1', 'p2'])
  })

  // Nothing bounds how many sends pile onto the agent's input line, so the
  // slide's budget must never truncate a genuine glue.
  it('retires a glued run far longer than the slide budget', () => {
    const words = Array.from({ length: 12 }, (_, index) => `w${index}`)
    const messages = [assistantTurn('m1', 'ready', 1000), userTurn('m2', words.join(' '), 5000)]
    const pending = words.map((word, index) => pendingSend(`p${index}`, word, 'm1'))
    expect(retiredIds(messages, pending)).toHaveLength(words.length)
  })

  it('skips a caption-less image echo instead of gluing it', () => {
    const messages = [assistantTurn('m1', 'ready', 1000), userTurn('m2', 'one two', 5000)]
    const pending = [
      pendingSend('p1', '', 'm1'),
      pendingSend('p2', 'one', 'm1'),
      pendingSend('p3', 'two', 'm1')
    ]
    expect(retiredIds(messages, pending)).toEqual(['p2', 'p3'])
  })

  it('keeps a captioned image echo and its neighbors until the preview is rebound', () => {
    const messages = [assistantTurn('m1', 'ready', 1000), userTurn('m2', 'one two', 5000)]
    const pending = [
      { ...pendingSend('p1', 'one', 'm1'), images: ['file:///a.png'] },
      pendingSend('p2', 'two', 'm1')
    ]
    expect(retiredIds(messages, pending)).toEqual([])
    expect(
      retireLandedMobileNativeChatPending(messages, pending, NO_IMAGE_ECHOES).map((item) => item.id)
    ).toEqual(['p1', 'p2'])
  })

  it('retires an image send glued with the text send beside it once its preview rebinds', () => {
    // Regression: one message typed, images attached, then a second send glued onto the
    // same input line. The image echo could not match the glued row (its matcher wanted
    // the whole row to equal the echo), and because an image echo was excluded from the
    // glue pass it also acted as a barrier — stranding the text send in a run of one,
    // which `matchGluedRun` rejects. Neither echo could ever retire, so the message
    // rendered twice over, with the image copy sorting below the reply it preceded.
    const messages = [assistantTurn('m1', 'ready', 1000), userTurn('m2', 'one two', 5000)]
    const pending = [
      { ...pendingSend('p1', 'one', 'm1'), images: ['file:///a.png'] },
      pendingSend('p2', 'two', 'm1')
    ]
    const rebound: ReadonlySet<string> = new Set(['p1'])
    expect([...selectGluedPendingIds(messages, pending, new Set(), rebound)].sort()).toEqual([
      'p1',
      'p2'
    ])
    expect(
      retireLandedMobileNativeChatPending(messages, pending, rebound).map((item) => item.id)
    ).toEqual([])
  })

  it('still strands nothing when the glued row belongs to an older baseline', () => {
    // The per-send boundary still applies to a rebound image echo.
    const messages = [userTurn('m1', 'one two', 1000), assistantTurn('m2', 'ready', 5000)]
    const pending = [
      { ...pendingSend('p1', 'one', 'm2'), images: ['file:///a.png'] },
      pendingSend('p2', 'two', 'm2')
    ]
    expect([...selectGluedPendingIds(messages, pending, new Set(), new Set(['p1']))]).toEqual([])
  })

  it('does nothing for a single pending send', () => {
    const messages = [assistantTurn('m1', 'ready', 1000), userTurn('m2', 'one two', 5000)]
    expect(retiredIds(messages, [pendingSend('p1', 'one', 'm1')])).toEqual([])
  })

  // The cursor slides past a head that cannot match, so a turn may try several
  // start positions — but one inspection budget covers the whole slide, keeping
  // the work linear in the run length rather than quadratic. The attempt already
  // in flight is allowed to overshoot the remaining budget, deliberately: that is
  // what guarantees a genuine long glue is never truncated.
  it('keeps segment inspection linear in the run length per transcript turn', () => {
    const pendingCount = 96
    const turnCount = 12
    const text = `${'a '.repeat(pendingCount)}x`
    const messages = [
      assistantTurn('tail', 'ready', 1000),
      ...Array.from({ length: turnCount }, (_, index) => userTurn(`m${index}`, text, 2000 + index))
    ]
    const pending = Array.from({ length: pendingCount }, (_, index) =>
      pendingSend(`p${index}`, 'a', 'tail', index + 1)
    )
    const startsWith = vi.spyOn(String.prototype, 'startsWith')
    let segmentChecks = 0
    try {
      expect(retiredIds(messages, pending)).toEqual([])
      segmentChecks = startsWith.mock.calls.length
    } finally {
      startsWith.mockRestore()
    }
    expect(segmentChecks).toBeLessThanOrEqual(turnCount * (2 * pendingCount + GLUE_SLIDE_BUDGET))
  })
})

describe('retireLandedMobileNativeChatPending', () => {
  it('retires exact landings by ordinal and glued rows in the same pass', () => {
    const messages = [
      assistantTurn('m1', 'ready', 1000),
      userTurn('m2', 'standalone', 4000),
      userTurn('m3', 'run the tests again', 5000)
    ]
    const pending = [
      pendingSend('p0', 'standalone', 'm1'),
      pendingSend('p1', 'run the tests', 'm2'),
      pendingSend('p2', 'again', 'm2')
    ]
    expect(retireLandedMobileNativeChatPending(messages, pending, NO_IMAGE_ECHOES)).toEqual([])
  })

  // The drafts effect early-outs on `next === current`; a fresh array on the
  // no-op path would re-enter it on every transcript frame.
  it('returns the input array itself when nothing retires', () => {
    const messages = [assistantTurn('m1', 'ready', 1000)]
    const pending = [pendingSend('p1', 'one', 'm1'), pendingSend('p2', 'two', 'm1')]
    expect(retireLandedMobileNativeChatPending(messages, pending, NO_IMAGE_ECHOES)).toBe(pending)
  })

  it('keeps sends whose glue candidate predates them', () => {
    const messages = [userTurn('m1', 'fix the bug', 1000), assistantTurn('m2', 'fixed', 1100)]
    const pending = [pendingSend('p1', 'fix the', 'm2'), pendingSend('p2', 'bug', 'm2')]
    expect(
      retireLandedMobileNativeChatPending(messages, pending, NO_IMAGE_ECHOES).map((item) => item.id)
    ).toEqual(['p1', 'p2'])
  })

  it('does not glue former neighbors across an exact-landed send', () => {
    const messages = [
      assistantTurn('m0', 'ready', 1000),
      userTurn('m1', 'middle', 2000),
      userTurn('m2', 'one two', 3000)
    ]
    const pending = [
      pendingSend('p1', 'one', 'm0'),
      pendingSend('p2', 'middle', 'm0'),
      pendingSend('p3', 'two', 'm0')
    ]
    expect(
      retireLandedMobileNativeChatPending(messages, pending, NO_IMAGE_ECHOES).map((item) => item.id)
    ).toEqual(['p1', 'p3'])
  })

  it('keeps image echoes until their preview is rebound', () => {
    const messages = [assistantTurn('m1', 'ready', 1000)]
    const pending = [{ ...pendingSend('p1', 'photo', 'm1'), images: ['file:///a.png'] }]
    expect(
      retireLandedMobileNativeChatPending(messages, pending, NO_IMAGE_ECHOES).map((item) => item.id)
    ).toEqual(['p1'])
    expect(retireLandedMobileNativeChatPending(messages, pending, new Set(['p1']))).toEqual([])
  })
})

describe('retireLandedMobileNativeChatPending on a PTY-typed send', () => {
  // A TUI may record the leading Ctrl+U transport byte as prompt content.
  const COMPOSER_TEXT = 'run the focused tests\nand summarize failures'
  const TRANSCRIPT_ROW = `\u0015${COMPOSER_TEXT}`

  it('retires the echo of a row the TUI pasted the Ctrl+U byte into', () => {
    const messages = [
      assistantTurn('m1', 'ready', 1000),
      userTurn('m2', TRANSCRIPT_ROW, 5000),
      assistantTurn('m3', 'on it', 6000)
    ]
    const pending = [pendingSend('p1', COMPOSER_TEXT, 'm1')]

    expect(retireLandedMobileNativeChatPending(messages, pending, NO_IMAGE_ECHOES)).toEqual([])
  })

  it('still holds the echo when no row carries the text at all', () => {
    const messages = [assistantTurn('m1', 'ready', 1000)]
    const pending = [pendingSend('p1', COMPOSER_TEXT, 'm1')]

    expect(retireLandedMobileNativeChatPending(messages, pending, NO_IMAGE_ECHOES)).toEqual(pending)
  })
})
