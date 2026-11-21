import { describe, expect, it } from 'vitest'
import { BotSchema } from '../../shared/bot-types'
import { makeTestBot } from './bot.test-fixture'
import {
  beginRun,
  DISMISSED_FOR_MS,
  EMPTY_BOT_LOOK,
  endRun,
  lookAroundUpNext,
  lookHistory,
  OPEN_FOR_MS,
  resolve,
  suggest,
  SUGGEST_REFUSALS,
  upNextItems,
  type BotLookState,
  type LookAroundRun,
  type SuggestInput
} from './bot-look-around-state'
import { markUpNextSeen, upNextUnseenByBot } from './bot-look-around-seen'
import {
  failedLooksInARow,
  LOOK_FAILURES_TO_TURN_OFF,
  lookFailureIsQuiet
} from './bot-look-around-failures'

const HOUR = 60 * 60 * 1000
const idea = (title: string, extra: Partial<SuggestInput> = {}): SuggestInput => ({
  title,
  why: 'It is waiting on you',
  ask: `Look at ${title}`,
  ...extra
})

function suggested(state: BotLookState, run: string, input: SuggestInput, now = 0) {
  const next = suggest(state, run, input, now)
  if (!next.outcome.ok) {
    throw new Error(next.outcome.refusal)
  }
  return { state: next.state, suggestion: next.outcome.suggestion }
}

function refusal(state: BotLookState, run: string, input: SuggestInput, now = 0) {
  const next = suggest(state, run, input, now)
  return next.outcome.ok ? null : next.outcome.refusal
}

describe('look-around suggestions', () => {
  it('takes five a run and refuses the sixth', () => {
    let state = beginRun(EMPTY_BOT_LOOK, 'run-1', 0)
    for (const n of [1, 2, 3, 4, 5]) {
      state = suggested(state, 'run-1', idea(`Item ${n}`)).state
    }
    expect(refusal(state, 'run-1', idea('Item 6'))).toBe(SUGGEST_REFUSALS.full)
    expect(refusal(state, 'run-1', idea('item  1'))).toBe(SUGGEST_REFUSALS.repeated)
  })

  it('refuses a session that is not a running look', () => {
    expect(refusal(EMPTY_BOT_LOOK, 'chat', idea('A'))).toBe(SUGGEST_REFUSALS.notALook)
    const ended = endRun(beginRun(EMPTY_BOT_LOOK, 'run-1', 0), 'run-1', 1)
    expect(refusal(ended, 'run-1', idea('A'))).toBe(SUGGEST_REFUSALS.notALook)
  })

  it('refuses a dismissed title in any case or spacing for 30 days', () => {
    let state = beginRun(EMPTY_BOT_LOOK, 'run-1', 0)
    const first = suggested(state, 'run-1', idea('Fix the flaky CI'))
    state = resolve(first.state, first.suggestion.id, 'dismissed', 0).state
    state = beginRun(endRun(state, 'run-1', 1), 'run-2', 2)
    expect(refusal(state, 'run-2', idea('  fix THE   flaky ci '), 2)).toBe(
      SUGGEST_REFUSALS.dismissed
    )
    const later = DISMISSED_FOR_MS + 10
    state = beginRun(state, 'run-3', later)
    expect(refusal(state, 'run-3', idea('Fix the flaky CI'), later)).toBeNull()
  })

  it('knows a suggestion by its link, so a reworded title is still the same one', () => {
    const pr = 'https://github.com/stablyai/orca/pull/12'
    let state = beginRun(EMPTY_BOT_LOOK, 'run-1', 0)
    const first = suggested(state, 'run-1', idea('Review PR #12', { link: pr }))
    expect(
      refusal(
        first.state,
        'run-1',
        idea('Look at Bob’s comments', {
          link: 'https://www.github.com/StablyAI/Orca/pull/12/files?w=1#r99'
        })
      )
    ).toBe(SUGGEST_REFUSALS.repeated)
    // Another PR with the same title is a different suggestion.
    state = suggested(
      first.state,
      'run-1',
      idea('Review PR #12', { link: 'https://github.com/stablyai/orca/pull/13' })
    ).state
    state = suggested(
      state,
      'run-1',
      idea('Look into ENG-1', { link: 'https://linear.app/globex/issue/ENG-1/old-slug' })
    ).state
    expect(
      refusal(
        state,
        'run-1',
        idea('Review the incident', { link: 'https://linear.app/globex/issue/eng-1/new-slug' })
      )
    ).toBe(SUGGEST_REFUSALS.repeated)
    state = beginRun(endRun(state, 'run-1', 1), 'run-2', 2)
    const again = suggested(state, 'run-2', idea('Answer the review on #12', { link: pr }), 2)
    expect(again.suggestion).toMatchObject({
      id: first.suggestion.id,
      title: 'Answer the review on #12'
    })
  })

  it('refuses a dismissed link under any title, and a dismissed title only without a link', () => {
    const pr = 'https://github.com/stablyai/orca/pull/12'
    let state = beginRun(EMPTY_BOT_LOOK, 'run-1', 0)
    const linked = suggested(state, 'run-1', idea('Review PR #12', { link: pr }))
    const bare = suggested(linked.state, 'run-1', idea('Fix the flaky CI'))
    state = resolve(bare.state, linked.suggestion.id, 'dismissed', 0).state
    state = resolve(state, bare.suggestion.id, 'dismissed', 0).state
    state = beginRun(endRun(state, 'run-1', 1), 'run-2', 2)
    expect(refusal(state, 'run-2', idea('Something new', { link: `${pr}#top` }), 2)).toBe(
      SUGGEST_REFUSALS.dismissed
    )
    expect(refusal(state, 'run-2', idea('Fix the flaky CI'), 2)).toBe(SUGGEST_REFUSALS.dismissed)
    expect(
      refusal(state, 'run-2', idea('Review PR #12', { link: 'https://github.com/o/r/pull/9' }), 2)
    ).toBeNull()
  })

  it('keeps a dismissal for its 30 days however many suggestions come after it', () => {
    let state = beginRun(EMPTY_BOT_LOOK, 'run-0', 0)
    const first = suggested(state, 'run-0', idea('Fix the flaky CI'))
    state = endRun(resolve(first.state, first.suggestion.id, 'dismissed', 0).state, 'run-0', 1)
    for (let run = 1; run <= 60; run++) {
      state = beginRun(state, `run-${run}`, run)
      for (const n of [1, 2, 3, 4, 5]) {
        state = suggested(state, `run-${run}`, idea(`Item ${run}.${n}`), run).state
      }
      state = endRun(state, `run-${run}`, run)
    }
    state = beginRun(state, 'last', 100)
    expect(state.suggestions.some((entry) => entry.title === 'Fix the flaky CI')).toBe(false)
    expect(refusal(state, 'last', idea('fix the flaky ci'), 100)).toBe(SUGGEST_REFUSALS.dismissed)
  })

  it.each([
    'https://example.com/x?access_token=abc',
    'https://example.com/x#token=abc',
    'https://user:pw@example.com/x',
    `https://example.com/x?q=ghp_${'a'.repeat(30)}`
  ])('refuses a link carrying a credential: %s', (link) => {
    const state = beginRun(EMPTY_BOT_LOOK, 'run-1', 0)
    expect(refusal(state, 'run-1', idea('Rotate', { link }))).toBe(SUGGEST_REFUSALS.secret)
    expect(
      refusal(state, 'run-1', idea('Rotate', { link: 'https://github.com/o/r/pull/1?w=1' }))
    ).toBeNull()
  })

  it('reads a bot whose saved Look around is malformed as unset, keeping the bot', () => {
    const parsed = BotSchema.safeParse({ ...makeTestBot(), lookAround: { on: 'yes' } })
    expect(parsed.success && parsed.data.lookAround).toBeUndefined()
    expect(parsed.success).toBe(true)
  })

  it('refuses an ask that carries a credential', () => {
    const state = beginRun(EMPTY_BOT_LOOK, 'run-1', 0)
    const token = `ghp_${'a'.repeat(30)}`
    expect(refusal(state, 'run-1', idea('Rotate', { ask: `use ${token}` }))).toBe(
      SUGGEST_REFUSALS.secret
    )
  })

  it('keeps the id and age of a title suggested again, and replaces what a finished look dropped', () => {
    let state = beginRun(EMPTY_BOT_LOOK, 'run-1', 0)
    const kept = suggested(state, 'run-1', idea('Review #12'))
    state = suggested(kept.state, 'run-1', idea('Old news')).state
    state = beginRun(endRun(state, 'run-1', HOUR), 'run-2', 4 * HOUR)
    const again = suggested(state, 'run-2', idea('review #12', { why: 'Still waiting' }), 4 * HOUR)
    expect(again.suggestion).toMatchObject({ id: kept.suggestion.id, createdAt: 0 })
    state = endRun(again.state, 'run-2', 5 * HOUR)
    expect(upNextItems(state, 5 * HOUR)).toEqual([
      expect.objectContaining({ id: kept.suggestion.id, why: 'Still waiting' })
    ])
  })

  it('keeps the list when a look fails, and drops open items after three days', () => {
    let state = beginRun(EMPTY_BOT_LOOK, 'run-1', 0)
    state = endRun(suggested(state, 'run-1', idea('A')).state, 'run-1', 1)
    state = endRun(beginRun(state, 'run-2', 2), 'run-2', 3, 'timed out')
    expect(upNextItems(state, 3).map((item) => item.title)).toEqual(['A'])
    expect(upNextItems(state, OPEN_FOR_MS + 10)).toEqual([])
  })

  it('resolves a suggestion once and tells the next look what happened', () => {
    let state = beginRun(EMPTY_BOT_LOOK, 'run-1', 0)
    const a = suggested(state, 'run-1', idea('A'))
    const b = suggested(a.state, 'run-1', idea('B'))
    state = suggested(b.state, 'run-1', idea('C')).state
    const started = resolve(state, a.suggestion.id, 'started', 1)
    expect(started.outcome).toMatchObject({ ok: true, suggestion: { ask: 'Look at A' } })
    state = resolve(started.state, b.suggestion.id, 'dismissed', 1).state
    for (const action of ['started', 'dismissed'] as const) {
      expect(resolve(state, a.suggestion.id, action, 2).outcome).toEqual({
        ok: false,
        refusal: 'already_started'
      })
    }
    expect(resolve(state, 'missing', 'started', 2).outcome).toEqual({
      ok: false,
      refusal: 'not_found'
    })
    expect(lookHistory(state, 2)).toEqual({ open: ['C'], started: ['A'], dismissed: ['B'] })
  })

  it('shows no Up next while Look around is off or the agent cannot look', () => {
    const store = { get: () => EMPTY_BOT_LOOK }
    expect(lookAroundUpNext(store, makeTestBot(), 0)).toMatchObject({ items: [] })
    const off = { on: false, every: 'every-4h', weekdaysOnly: true, focus: '' } as const
    expect(lookAroundUpNext(store, makeTestBot({ lookAround: off }), 0)).toBeUndefined()
    expect(lookAroundUpNext(store, makeTestBot({ agent: 'opencode' }), 0)).toBeUndefined()
  })

  it('names the running look and counts what came after the owner last saw Up next', () => {
    let state = beginRun(EMPTY_BOT_LOOK, 'run-1', 0)
    state = suggested(state, 'run-1', idea('A'), 1).state
    const store = { get: () => state }
    const bot = makeTestBot()
    expect(lookAroundUpNext(store, bot, 2)?.state).toMatchObject({
      running: true,
      runSessionId: 'run-1',
      seenAt: 0
    })
    expect(upNextUnseenByBot(store, [bot], 2)).toEqual({ [bot.id]: 1 })

    state = markUpNextSeen(state, 2)
    expect(state.seenAt).toBe(2)
    expect(upNextUnseenByBot(store, [bot], 2)).toEqual({})
    // Nothing new: seeing it again changes nothing, so it writes nothing.
    expect(markUpNextSeen(state, 3)).toBe(state)

    state = suggested(state, 'run-1', idea('B'), 4).state
    expect(upNextUnseenByBot(store, [bot], 4)).toEqual({ [bot.id]: 1 })
    state = endRun(state, 'run-1', 5)
    expect(lookAroundUpNext(store, bot, 5)?.state).not.toHaveProperty('runSessionId')
  })
})

describe('a failed look', () => {
  const failed = (sessionId: string, alerted = false): LookAroundRun => ({
    sessionId,
    startedAt: 0,
    endedAt: 1,
    error: 'x',
    ...(alerted ? { alerted: true as const } : {})
  })
  const state = (runs: LookAroundRun[]): BotLookState => ({ ...EMPTY_BOT_LOOK, runs })
  const now: LookAroundRun = { sessionId: 'now', startedAt: 2 }

  it('notifies once per streak and starts over after a success', () => {
    const success = { sessionId: 'ok', startedAt: 0, endedAt: 1 }
    expect(lookFailureIsQuiet(state([failed('told', true), failed('later'), now]), 'now')).toBe(
      true
    )
    const afterSuccess = [failed('told', true), success, failed('could-not-start'), now]
    expect(lookFailureIsQuiet(state(afterSuccess), 'now')).toBe(false)
  })

  it('is news again as the failure that turns Look around off', () => {
    const nine = [failed('told', true), ...Array.from({ length: 8 }, (_, n) => failed(`f${n}`))]
    expect(failedLooksInARow(state(nine))).toBe(LOOK_FAILURES_TO_TURN_OFF - 1)
    expect(lookFailureIsQuiet(state([...nine, now]), 'now')).toBe(false)
    expect(lookFailureIsQuiet(state([...nine.slice(0, -1), now]), 'now')).toBe(true)
  })

  it('is never quiet for a session that is no look', () => {
    expect(lookFailureIsQuiet(state([failed('told', true)]), 'a-chat')).toBe(false)
  })
})
