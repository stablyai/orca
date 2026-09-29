import { describe, expect, it } from 'vitest'
import { selectStructuredAgentContextUsage } from '../../shared/structured-agent-session-context-usage'
import { readAgentJournalTurn } from '../../shared/agent-session-turn-record'
import { bindClaudeContextUsageCapture, claudeContextWindowHint } from './claude-context-usage'
import {
  assistantFrame,
  initFrame,
  resultFrame,
  setup,
  userFrame
} from './claude-context-usage-test-support'

const SONNET = 'claude-sonnet-5'
const OPUS = 'claude-opus-5-5'

const answer = (model: string, totalTokens: number, rawMaxTokens: number) => ({
  model,
  totalTokens,
  rawMaxTokens,
  categories: []
})

/** A new session whose configured model the host applied before the first send. */
function session(init: string, configured?: string) {
  const t = setup({ init })
  if (configured !== undefined) {
    t.translator.modelWritten(configured)
  }
  const pending: ((value: unknown) => void)[] = []
  bindClaudeContextUsageCapture(
    { getContextUsage: () => new Promise((resolve) => pending.push(resolve)) },
    t.translator,
    { now: () => 90_000 }
  )
  const reply = async (value: unknown, request = pending.length - 1): Promise<void> => {
    pending[request]?.(value)
    for (let index = 0; index < 4; index += 1) {
      await Promise.resolve()
    }
  }
  const ring = () => selectStructuredAgentContextUsage(t.items())
  return { ...t, pending, reply, ring }
}

describe('the window a configured model name implies', () => {
  it.each([
    // First-party runs these natively at 1M; a gateway or cloud provider runs them at 200k.
    ['opus', null],
    ['sonnet', null],
    ['fable', null],
    ['best', null],
    ['claude-fable-5-1', null],
    ['claude-opus-5-5', null],
    ['claude-sonnet-5', null],
    // Plan mode runs another model: Opus for `opusplan`, Sonnet for `haiku`.
    ['opusplan', null],
    ['haiku', null],
    ['default', null],
    ['', null],
    ['opus[1m]', 1_000_000],
    ['sonnet[1m]', 1_000_000],
    ['fable[1m]', 1_000_000],
    ['opusplan[1m]', 1_000_000],
    ['claude-opus-5-5[1m]', 1_000_000],
    ['Sonnet[1M]', 1_000_000]
  ])('%s → %s', (model, window) => {
    expect(claudeContextWindowHint(model)).toBe(window)
  })
})

describe('the context ring before the first window is measured', () => {
  it.each([
    ['opus[1m]', `${OPUS}[1m]`, OPUS, 1_000_000, 5],
    ['sonnet[1m]', `${SONNET}[1m]`, SONNET, 1_000_000, 5]
  ])(
    'sizes the first response of a new session from its model (%s)',
    (configured, init, responder, window, share) => {
      const s = session(init, configured)
      s.handle(userFrame('turn-a', 1_000))
      s.handle(assistantFrame('reply-a', 2_000, 50_000, undefined, responder))
      expect(s.ring()).toEqual({
        usedTokens: 50_000,
        windowTokens: window,
        percentage: share,
        estimated: true,
        categories: []
      })
      expect(readAgentJournalTurn(s.turnRow('turn-a')!.body)?.contextUsage?.window).toEqual({
        tokens: window,
        capturedAt: 2_000
      })
      s.translator.dispose()
    }
  )

  it('looks for a window already in the journal only on the first response', () => {
    const s = session(`${SONNET}[1m]`, 'sonnet[1m]')
    s.handle(userFrame('turn-a', 1_000))
    s.handle(assistantFrame('reply-a1', 2_000, 50_000, undefined, SONNET))
    s.handle(assistantFrame('reply-a2', 3_000, 60_000, undefined, SONNET))
    s.handle(assistantFrame('reply-a3', 4_000, 70_000, undefined, SONNET))
    expect(s.scans.count).toBe(1)
    expect(s.ring()).toMatchObject({ usedTokens: 70_000, windowTokens: 1_000_000 })
    s.translator.dispose()
  })

  it.each(['default', 'opus', 'opusplan'])(
    'shows no ring under `%s` until the result states the window',
    (configured) => {
      const s = session(`${OPUS}[1m]`, configured)
      s.handle(userFrame('turn-a', 1_000))
      s.handle(assistantFrame('reply-a', 2_000, 50_000, undefined, OPUS))
      expect(s.ring()).toBeNull()
      s.handle(resultFrame(3_000, { [`${OPUS}[1m]`]: { contextWindow: 1_000_000 } }))
      expect(s.ring()).toMatchObject({ usedTokens: 50_000, windowTokens: 1_000_000 })
      s.translator.dispose()
    }
  )

  it.each([
    ['sonnet[1m]', `${SONNET}[1m]`, 1_000_000, 5],
    ['sonnet', SONNET, 200_000, 25]
  ])(
    'sizes the first response from the report a pick of %s made before any turn',
    async (configured, reported, window, share) => {
      const s = session(reported)
      // What the host does for a model picked in a chat with no turn row for the report to land on.
      s.translator.modelMayHaveChanged()
      s.translator.modelWritten(configured)
      await s.reply(answer(reported, 20_000, window))
      s.handle(userFrame('turn-a', 1_000))
      s.handle(assistantFrame('reply-a', 2_000, 50_000, undefined, SONNET))
      expect(s.ring()).toMatchObject({
        usedTokens: 50_000,
        windowTokens: window,
        percentage: share
      })
      s.translator.dispose()
    }
  )

  it('lets the result and then the report replace the implied window', async () => {
    const s = session(`${SONNET}[1m]`, 'sonnet[1m]')
    s.handle(userFrame('turn-a', 1_000))
    s.handle(assistantFrame('reply-a', 2_000, 100_000, undefined, SONNET))
    expect(s.ring()).toMatchObject({ windowTokens: 1_000_000, percentage: 10 })
    s.handle(resultFrame(3_000, { [SONNET]: { contextWindow: 400_000 } }))
    expect(s.ring()).toMatchObject({ usedTokens: 100_000, windowTokens: 400_000, percentage: 25 })
    await s.reply(answer(SONNET, 101_000, 500_000))
    expect(s.ring()).toMatchObject({ usedTokens: 101_000, windowTokens: 500_000, estimated: false })
    // A measured window stands: the next turn's estimates divide by it, not the name's.
    s.handle(initFrame(SONNET, 3_900))
    s.handle(userFrame('turn-b', 4_000))
    s.handle(assistantFrame('reply-b', 5_000, 110_000, undefined, SONNET))
    expect(s.ring()).toMatchObject({ usedTokens: 110_000, windowTokens: 500_000, estimated: true })
    s.translator.dispose()
  })

  it('keeps estimates flowing against a written model straight away, until its report lands', async () => {
    const s = session(SONNET, 'sonnet')
    s.handle(userFrame('turn-a', 1_000))
    s.handle(assistantFrame('reply-a', 2_000, 150_000, undefined, SONNET))
    s.handle(resultFrame(3_000, { [SONNET]: { contextWindow: 200_000 } }))
    await s.reply(answer(SONNET, 151_000, 200_000))
    expect(s.ring()).toMatchObject({ windowTokens: 200_000, percentage: 76 })

    // What the host does for a model write the child applied.
    s.translator.modelMayHaveChanged()
    s.translator.modelWritten('sonnet[1m]')
    const switched = s.pending.length - 1
    expect(s.ring()).toBeNull()
    s.handle(initFrame(`${SONNET}[1m]`, 3_900))
    s.handle(userFrame('turn-b', 4_000))
    s.handle(assistantFrame('reply-b', 5_000, 160_000, undefined, SONNET))
    expect(s.ring()).toMatchObject({ usedTokens: 160_000, windowTokens: 1_000_000, percentage: 16 })

    await s.reply(answer(`${SONNET}[1m]`, 161_000, 900_000), switched)
    expect(s.turnRow('turn-b')?.body).toMatchObject({
      contextUsage: { window: { tokens: 900_000 } }
    })
    s.handle(assistantFrame('reply-b2', 6_000, 180_000, undefined, SONNET))
    expect(s.ring()).toMatchObject({ usedTokens: 180_000, windowTokens: 900_000, percentage: 20 })
    s.translator.dispose()
  })

  it('still hides the ring across a permission-mode change until the report lands', async () => {
    const s = session(`${SONNET}[1m]`, 'sonnet[1m]')
    s.handle(userFrame('turn-a', 1_000))
    s.handle(assistantFrame('reply-a', 2_000, 50_000, undefined, SONNET))
    expect(s.ring()).toMatchObject({ windowTokens: 1_000_000 })

    // A permission-mode write names no model, so nothing says which window serves now.
    s.translator.modelMayHaveChanged()
    const toggled = s.pending.length - 1
    s.handle(assistantFrame('reply-a2', 3_000, 60_000, undefined, SONNET))
    expect(s.ring()).toBeNull()
    await s.reply(answer(`${OPUS}[1m]`, 61_000, 1_000_000), toggled)
    s.handle(assistantFrame('reply-a3', 4_000, 70_000, undefined, OPUS))
    expect(s.ring()).toMatchObject({ usedTokens: 70_000, windowTokens: 1_000_000, percentage: 7 })
    s.translator.dispose()
  })

  it('still hides the ring when a response moves to another model mid-turn', () => {
    const s = session(`${SONNET}[1m]`, 'opusplan[1m]')
    s.handle(userFrame('turn-a', 1_000))
    s.handle(assistantFrame('reply-a1', 2_000, 50_000, undefined, OPUS))
    expect(s.ring()).toMatchObject({ windowTokens: 1_000_000 })
    s.handle(assistantFrame('reply-a2', 3_000, 60_000, undefined, SONNET))
    expect(s.ring()).toBeNull()
    s.handle(assistantFrame('reply-a3', 4_000, 70_000, undefined, SONNET))
    expect(s.ring()).toBeNull()
    s.translator.dispose()
  })
})
