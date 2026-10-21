import { describe, expect, it } from 'vitest'
import { selectStructuredAgentContextUsage } from '../../shared/structured-agent-session-context-usage'
import { readAgentJournalTurn } from '../../shared/agent-session-turn-record'
import { bindClaudeContextUsageCapture } from './claude-context-usage'
import {
  assistantFrame,
  initFrame,
  resultFrame,
  setup,
  userFrame
} from './claude-context-usage-test-support'

const SONNET = 'claude-sonnet-5'
const OPUS = 'claude-opus-5-5'
// Shape measured from Claude Code 2.1.280: plan mode under `opusplan` keys Opus with `[1m]`.
const PLAN_USAGE = {
  [SONNET]: { contextWindow: 200_000 },
  [`${OPUS}[1m]`]: { contextWindow: 1_000_000 }
}

/** `get_context_usage` answers the model the CLI holds now, turn or no turn. */
const answer = (model: string, totalTokens: number, rawMaxTokens: number) => ({
  model,
  totalTokens,
  rawMaxTokens,
  categories: []
})

/** A translator whose report requests go through the real capture, drop rule included. */
function session(init: string) {
  const t = setup({ init })
  const pending: ((value: unknown) => void)[] = []
  bindClaudeContextUsageCapture(
    { getContextUsage: () => new Promise((resolve) => pending.push(resolve)) },
    t.translator,
    { now: () => 90_000 }
  )
  const settle = async (): Promise<void> => {
    for (let index = 0; index < 4; index += 1) {
      await Promise.resolve()
    }
  }
  /** Answer one request, the newest by default. */
  const reply = async (value: unknown, request = pending.length - 1): Promise<void> => {
    pending[request]?.(value)
    await settle()
  }
  const ring = () => selectStructuredAgentContextUsage(t.items())
  const unknownWrites = () =>
    t.appends.filter(
      (entry) => readAgentJournalTurn(entry.body)?.contextUsage?.used?.kind === 'unknown'
    ).length
  return { ...t, pending, reply, ring, unknownWrites }
}

describe('the context ring across a model change', () => {
  it.each([
    [SONNET, 200_000, 30],
    [`${SONNET}[1m]`, 1_000_000, 6]
  ])('divides an estimate by the window the report states (%s)', async (model, window, share) => {
    const s = session(model)
    s.handle(userFrame('turn-a', 1_000))
    // A local command's turn: its result carries no per-model usage, so only the report states the window.
    s.handle(resultFrame(2_000))
    await s.reply(answer(model, 50_000, window))
    s.handle(initFrame(model, 2_900))
    s.handle(userFrame('turn-b', 3_000))
    s.handle(assistantFrame('reply-b', 4_000, 60_000, undefined, SONNET))
    expect(s.ring()).toEqual({
      usedTokens: 60_000,
      windowTokens: window,
      percentage: share,
      estimated: true,
      categories: []
    })
    // Neither fact names a model: pairing them is the writer's job.
    expect(readAgentJournalTurn(s.turnRow('turn-a')!.body)?.contextUsage?.window).toEqual({
      tokens: window,
      capturedAt: 90_000
    })
    expect(readAgentJournalTurn(s.turnRow('turn-b')!.body)?.contextUsage?.used).toEqual({
      kind: 'estimate',
      usage: {
        inputTokens: 60_000,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        outputTokens: 4
      },
      capturedAt: 4_000
    })
    s.translator.dispose()
  })

  it('blanks the ring at an idle switch between the 1M and 200k windows of one model', async () => {
    const s = session(SONNET)
    s.handle(userFrame('turn-a', 1_000))
    s.handle(assistantFrame('reply-a', 2_000, 150_000, undefined, SONNET))
    s.handle(resultFrame(3_000, { [SONNET]: { contextWindow: 200_000 } }))
    await s.reply(answer(SONNET, 151_000, 200_000))
    expect(s.ring()).toMatchObject({ windowTokens: 200_000, percentage: 76 })

    const requests = s.pending.length
    s.translator.modelMayHaveChanged()
    expect(s.turnRow('turn-a')?.body).toMatchObject({ contextUsage: { used: { kind: 'unknown' } } })
    expect(s.ring()).toBeNull()
    expect(s.pending).toHaveLength(requests + 1)
    await s.reply(answer(`${SONNET}[1m]`, 151_000, 1_000_000))
    expect(s.ring()).toMatchObject({ usedTokens: 151_000, windowTokens: 1_000_000 })

    // Responses name both windows alike; the new one is already on the journal.
    s.handle(initFrame(`${SONNET}[1m]`, 3_900))
    s.handle(userFrame('turn-b', 4_000))
    s.handle(assistantFrame('reply-b', 5_000, 160_000, undefined, SONNET))
    expect(s.ring()).toMatchObject({ usedTokens: 160_000, windowTokens: 1_000_000, percentage: 16 })
    s.handle(resultFrame(6_000, { [`${SONNET}[1m]`]: { contextWindow: 1_000_000 } }))
    await s.reply(answer(`${SONNET}[1m]`, 161_000, 1_000_000))

    s.translator.modelMayHaveChanged()
    expect(s.ring()).toBeNull()
    await s.reply(answer(SONNET, 161_000, 200_000))
    expect(s.ring()).toMatchObject({ windowTokens: 200_000, percentage: 81 })
    s.translator.dispose()
  })

  it('follows an idle plan toggle under opusplan to the Opus window and back', async () => {
    const s = session(SONNET)
    s.handle(userFrame('turn-a', 1_000))
    s.handle(assistantFrame('reply-a', 2_000, 50_000, undefined, SONNET))
    s.handle(resultFrame(3_000, { [SONNET]: PLAN_USAGE[SONNET] }))
    await s.reply(answer(SONNET, 51_000, 200_000))

    s.translator.modelMayHaveChanged()
    expect(s.ring()).toBeNull()
    await s.reply(answer(`${OPUS}[1m]`, 51_000, 1_000_000))
    expect(s.ring()).toMatchObject({ windowTokens: 1_000_000, estimated: false })
    // The init keeps naming the resting model while plan mode answers on Opus.
    s.handle(initFrame(SONNET, 3_900))
    s.handle(userFrame('turn-b', 4_000))
    s.handle(assistantFrame('reply-b', 5_000, 60_000, undefined, OPUS))
    expect(s.ring()).toMatchObject({ usedTokens: 60_000, windowTokens: 1_000_000, percentage: 6 })
    s.handle(resultFrame(6_000, PLAN_USAGE))
    expect(s.ring()).toMatchObject({ usedTokens: 60_000, windowTokens: 1_000_000 })
    await s.reply(answer(`${OPUS}[1m]`, 61_000, 1_000_000))

    s.translator.modelMayHaveChanged()
    expect(s.ring()).toBeNull()
    await s.reply(answer(SONNET, 61_000, 200_000))
    s.handle(initFrame(SONNET, 6_900))
    s.handle(userFrame('turn-c', 7_000))
    s.handle(assistantFrame('reply-c', 8_000, 70_000, undefined, SONNET))
    expect(s.ring()).toMatchObject({ usedTokens: 70_000, windowTokens: 200_000, percentage: 35 })
    s.translator.dispose()
  })

  it('holds estimates from the moment an approved plan hands the turn to another model', async () => {
    const s = session(SONNET)
    s.handle(userFrame('turn-a', 1_000))
    s.handle(assistantFrame('reply-a', 2_000, 100_000, undefined, OPUS))
    s.handle(resultFrame(3_000, PLAN_USAGE))
    await s.reply(answer(`${OPUS}[1m]`, 101_000, 1_000_000))
    s.handle(initFrame(SONNET, 3_900))
    s.handle(userFrame('turn-b', 4_000))
    s.handle(assistantFrame('reply-b1', 5_000, 110_000, undefined, OPUS))
    expect(s.ring()).toMatchObject({ usedTokens: 110_000, windowTokens: 1_000_000 })

    const requests = s.pending.length
    s.handle(assistantFrame('reply-b2', 6_000, 120_000, undefined, SONNET))
    expect(s.ring()).toBeNull()
    expect(s.unknownWrites()).toBe(1)
    expect(s.pending).toHaveLength(requests + 1)
    s.handle(assistantFrame('reply-b3', 7_000, 130_000, undefined, SONNET))
    expect(s.unknownWrites()).toBe(1)
    expect(s.turnRow('turn-b')?.body).toMatchObject({ contextUsage: { used: { kind: 'unknown' } } })
    // The turn moved past the count it asked for, but not past the window: the next response restores the ring.
    await s.reply(answer(SONNET, 121_000, 200_000), requests)
    expect(s.turnRow('turn-b')?.body).toMatchObject({
      contextUsage: { window: { tokens: 200_000 }, used: { kind: 'unknown' } }
    })
    s.handle(assistantFrame('reply-b4', 7_500, 140_000, undefined, SONNET))
    expect(s.ring()).toMatchObject({ usedTokens: 140_000, windowTokens: 200_000, percentage: 70 })

    s.handle(resultFrame(8_000, PLAN_USAGE))
    expect(s.ring()).toMatchObject({ usedTokens: 140_000, windowTokens: 200_000 })
    await s.reply(answer(SONNET, 141_000, 200_000))
    expect(s.ring()).toMatchObject({ usedTokens: 141_000, windowTokens: 200_000, estimated: false })
    s.translator.dispose()
  })

  it('clears the hold at the turn result when the report a mid-turn write asked for never answers', async () => {
    const s = session(SONNET)
    s.handle(userFrame('turn-a', 1_000))
    s.handle(assistantFrame('reply-a', 2_000, 50_000, undefined, SONNET))
    s.handle(resultFrame(3_000, { [SONNET]: { contextWindow: 200_000 } }))
    await s.reply(answer(SONNET, 51_000, 200_000))
    s.handle(userFrame('turn-b', 4_000))
    s.handle(assistantFrame('reply-b1', 5_000, 60_000, undefined, SONNET))

    // A permission-mode write mid-turn whose report never comes back.
    s.translator.modelMayHaveChanged()
    const unanswered = s.pending.length - 1
    s.handle(assistantFrame('reply-b2', 6_000, 70_000, undefined, SONNET))
    expect(s.ring()).toBeNull()
    s.handle(assistantFrame('reply-b3', 7_000, 80_000, undefined, SONNET))
    expect(s.ring()).toBeNull()
    expect(s.unknownWrites()).toBe(1)
    expect(s.pending).toHaveLength(unanswered + 1)

    s.handle(resultFrame(8_000, { [SONNET]: { contextWindow: 200_000 } }))
    // The report the result asks for fails too.
    await s.reply(undefined)
    expect(s.ring()).toBeNull()
    s.handle(userFrame('turn-c', 9_000))
    s.handle(assistantFrame('reply-c', 10_000, 90_000, undefined, SONNET))
    expect(s.ring()).toMatchObject({ usedTokens: 90_000, windowTokens: 200_000, percentage: 45 })
    s.translator.dispose()
  })

  it('lets a later turn result restate the window an earlier report stated', async () => {
    const s = session(`${SONNET}[1m]`)
    s.handle(userFrame('turn-a', 1_000))
    s.handle(assistantFrame('reply-a', 2_000, 140_000, undefined, SONNET))
    s.handle(resultFrame(3_000))
    await s.reply(answer(`${SONNET}[1m]`, 141_000, 1_000_000))
    expect(s.ring()).toMatchObject({ windowTokens: 1_000_000 })

    // The CLI runs the 200k window next turn with no option write, and that turn's report fails.
    s.handle(initFrame(SONNET, 3_900))
    s.handle(userFrame('turn-b', 4_000))
    s.handle(assistantFrame('reply-b', 5_000, 150_000, undefined, SONNET))
    s.handle(
      resultFrame(6_000, {
        [`${SONNET}[1m]`]: { contextWindow: 1_000_000 },
        [SONNET]: { contextWindow: 200_000 }
      })
    )
    await s.reply(undefined)
    expect(s.ring()).toMatchObject({ usedTokens: 150_000, windowTokens: 200_000, percentage: 75 })
    s.translator.dispose()
  })

  it('keeps the window of a switch the user sends straight after', async () => {
    const s = session(SONNET)
    s.handle(userFrame('turn-a', 1_000))
    s.handle(assistantFrame('reply-a', 2_000, 150_000, undefined, SONNET))
    s.handle(resultFrame(3_000, { [SONNET]: { contextWindow: 200_000 } }))
    await s.reply(answer(SONNET, 151_000, 200_000))

    s.translator.modelMayHaveChanged()
    const switched = s.pending.length - 1
    // The send lands before the switch's report does.
    s.translator.markContextActivity()
    s.handle(initFrame(`${SONNET}[1m]`, 3_900))
    s.handle(userFrame('turn-b', 4_000))
    await s.reply(answer(`${SONNET}[1m]`, 151_000, 1_000_000), switched)
    // Its count describes the context before the send, so only the window lands.
    expect(s.ring()).toBeNull()
    expect(s.turnRow('turn-b')?.body).toMatchObject({
      contextUsage: { window: { tokens: 1_000_000 } }
    })
    expect(readAgentJournalTurn(s.turnRow('turn-b')!.body)?.contextUsage?.used).toBeUndefined()
    s.handle(assistantFrame('reply-b', 5_000, 160_000, undefined, SONNET))
    expect(s.ring()).toMatchObject({ usedTokens: 160_000, windowTokens: 1_000_000, percentage: 16 })
    s.translator.dispose()
  })

  it('does not let a turn result undo the window a mid-turn switch between 1M and 200k reported', async () => {
    const s = session(`${SONNET}[1m]`)
    s.handle(userFrame('turn-a', 1_000))
    s.handle(assistantFrame('reply-a', 2_000, 140_000, undefined, SONNET))
    s.handle(resultFrame(3_000, { [`${SONNET}[1m]`]: { contextWindow: 1_000_000 } }))
    await s.reply(answer(`${SONNET}[1m]`, 141_000, 1_000_000))
    s.handle(initFrame(`${SONNET}[1m]`, 3_900))
    s.handle(userFrame('turn-b', 4_000))
    s.handle(assistantFrame('reply-b1', 5_000, 145_000, undefined, SONNET))

    s.translator.modelMayHaveChanged()
    const switched = s.pending.length - 1
    s.handle(assistantFrame('reply-b2', 6_000, 150_000, undefined, SONNET))
    await s.reply(answer(SONNET, 151_000, 200_000), switched)
    s.handle(assistantFrame('reply-b3', 7_000, 160_000, undefined, SONNET))
    expect(s.ring()).toMatchObject({ usedTokens: 160_000, windowTokens: 200_000, percentage: 80 })

    // The result keys both windows, and the turn's init still names the 1M one.
    s.handle(
      resultFrame(8_000, {
        [`${SONNET}[1m]`]: { contextWindow: 1_000_000 },
        [SONNET]: { contextWindow: 200_000 }
      })
    )
    expect(s.ring()).toMatchObject({ usedTokens: 160_000, windowTokens: 200_000, percentage: 80 })
    // The user sends before the result's report lands; its window still does.
    s.translator.markContextActivity()
    await s.reply(answer(SONNET, 161_000, 200_000))
    s.handle(initFrame(SONNET, 8_900))
    s.handle(userFrame('turn-c', 9_000))
    s.handle(assistantFrame('reply-c', 10_000, 170_000, undefined, SONNET))
    expect(s.ring()).toMatchObject({ usedTokens: 170_000, windowTokens: 200_000, percentage: 85 })
    s.translator.dispose()
  })
})
