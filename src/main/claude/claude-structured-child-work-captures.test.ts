// Real Claude CLI frame orders, replayed through the adapter into a real host: each child ends on
// its own terminal frame, at that frame's time, and on nothing the parent does.

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CapturedFrame } from './claude-captured-frame-builders.test-fixture'
import {
  FOREGROUND_SUCCESS,
  INTERRUPTED_BETWEEN_TOOLS,
  INTERRUPTED_IN_OWN_SHELL
} from './claude-captured-foreground-frames.test-fixture'
import { MOVED_TO_BACKGROUND, RESUMED_BY_MESSAGE } from './claude-captured-task-frames.test-fixture'
import { hostWithParent, producer, T0 } from './claude-child-work-producer-harness.test-fixture'

vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({ getCohortAtEmit: vi.fn(() => ({})) }))
afterEach(() => vi.restoreAllMocks())

function until(frames: CapturedFrame[], at: number): [CapturedFrame[], CapturedFrame[]] {
  const split = frames.findIndex((captured) => captured.at >= at)
  return [frames.slice(0, split), frames.slice(split)]
}

describe('Claude child work from captured frame orders', () => {
  it("keeps an agent's own shell live past the parent's turn, until the shell's own ending", async () => {
    const run = await producer(hostWithParent())
    const [beforeEnding, fromEnding] = until(MOVED_TO_BACKGROUND, 51_275)
    run.replay(beforeEnding)
    // The parent's `result` (+12,610 ms) and every roster since have passed.
    expect(run.byDescription('Sleep 45 seconds then print 1')).toMatchObject({
      membership: 'live',
      residency: 'foreground'
    })
    run.replay(fromEnding)
    const agent = run.byDescription('Run 45s sleep command')
    expect(run.byDescription('Sleep 45 seconds then print 1')).toMatchObject({
      membership: 'settled',
      outcome: 'succeeded',
      settledAt: T0 + 51_275,
      parentChildWorkId: agent?.childWorkId
    })
    expect(agent).toMatchObject({
      membership: 'settled',
      outcome: 'succeeded',
      residency: 'background',
      settledAt: T0 + 52_441,
      lastMessage: 'The command completed after ~45 seconds. Exact stdout: `1`',
      totalTokens: 22_160,
      invocation: { invocationId: 'toolu_agent', generation: 1 }
    })
    expect(run.ingested.flatMap((outcome) => outcome?.rejected ?? [])).toEqual([])
  })

  it("does not end a moved agent on its spawn call's early result", async () => {
    const run = await producer(hostWithParent())
    // The same capture with the spawn call's result delivered before the move is announced.
    const launched = MOVED_TO_BACKGROUND.findIndex(
      ({ frame }) => frame.type === 'user' && frame.parent_tool_use_id === null
    )
    const moved = MOVED_TO_BACKGROUND.findIndex(
      ({ frame }) => frame.subtype === 'background_tasks_changed'
    )
    const reordered = [...MOVED_TO_BACKGROUND]
    const [spawnResult] = reordered.splice(launched, 1)
    reordered.splice(moved, 0, { ...spawnResult!, at: MOVED_TO_BACKGROUND[moved]!.at })
    run.replay(reordered)
    const agent = run.byDescription('Run 45s sleep command')
    expect(agent).toMatchObject({
      membership: 'settled',
      outcome: 'succeeded',
      settledAt: T0 + 52_441,
      invocation: { invocationId: 'toolu_agent', generation: 1 }
    })
    expect(agent?.previousInvocations).toBeUndefined()
  })

  it('keeps a background child live when a roster omits it without its own ending', async () => {
    const run = await producer(hostWithParent())
    const [launch] = until(RESUMED_BY_MESSAGE, 5_077)
    run.replay(launch)
    // A roster that no longer lists the agent, and no terminal frame from it.
    run.replay([
      { at: 6_000, frame: { type: 'system', subtype: 'background_tasks_changed', tasks: [] } }
    ])
    expect(run.byDescription('Run echo first-run command')).toMatchObject({
      membership: 'live',
      residency: 'background'
    })
  })

  it('settles what still runs when the session ends, and keeps every record', async () => {
    const run = await producer(hostWithParent())
    const [running] = until(MOVED_TO_BACKGROUND, 51_275)
    run.replay(running)
    await run.adapter.closeSession('session-1')
    expect(
      run.records().map(({ description, membership, outcome }) => ({
        description,
        membership,
        outcome
      }))
    ).toEqual([
      { description: 'Run 45s sleep command', membership: 'settled', outcome: 'unknown' },
      { description: 'Sleep 45 seconds then print 1', membership: 'settled', outcome: 'unknown' }
    ])
  })

  it('opens a second run when a finished agent is started again', async () => {
    const run = await producer(hostWithParent())
    const [firstRun, secondRun] = until(RESUMED_BY_MESSAGE, 16_118)
    run.replay(firstRun)
    expect(run.byDescription('Run echo first-run command')).toMatchObject({
      membership: 'settled',
      outcome: 'succeeded',
      invocation: { invocationId: 'toolu_agent', generation: 1 }
    })
    const [restart, rest] = until(secondRun, 16_166)
    run.replay(restart)
    expect(run.byDescription('Run echo first-run command')).toMatchObject({
      membership: 'live',
      invocation: { invocationId: 'toolu_message', generation: 2 },
      previousInvocations: [expect.objectContaining({ outcome: 'succeeded' })]
    })
    run.replay(rest)
    expect(run.byDescription('Run echo first-run command')).toMatchObject({
      membership: 'settled',
      outcome: 'succeeded',
      settledAt: T0 + 19_568,
      lastMessage: 'The command executed successfully. Output: `second-run`',
      totalTokens: 16_259,
      invocation: { invocationId: 'toolu_message', generation: 2 }
    })
    expect(run.records()).toHaveLength(1)
  })

  it('ends an agent interrupted between tools as cancelled, its own stop first', async () => {
    const run = await producer(hostWithParent())
    run.replay(INTERRUPTED_BETWEEN_TOOLS)
    expect(run.records()).toEqual([
      expect.objectContaining({
        description: 'Run sleep command and report',
        membership: 'settled',
        outcome: 'cancelled',
        settledAt: T0 + 11_019
      })
    ])
    expect(run.ingested.flatMap((outcome) => outcome?.rejected ?? [])).toEqual([])
  })

  it('ends an agent interrupted in its own shell, and the shell, as cancelled', async () => {
    const run = await producer(hostWithParent())
    run.replay(INTERRUPTED_IN_OWN_SHELL)
    const agent = run.byDescription('Run sleep command and report')
    expect(agent).toMatchObject({
      membership: 'settled',
      outcome: 'cancelled',
      settledAt: T0 + 11_325
    })
    expect(run.byDescription('Sleep 45 seconds then print 1')).toMatchObject({
      membership: 'settled',
      outcome: 'cancelled',
      settledAt: T0 + 11_321,
      parentChildWorkId: agent?.childWorkId
    })
    expect(run.ingested.flatMap((outcome) => outcome?.rejected ?? [])).toEqual([])
  })

  it("keeps a finished foreground agent's final summary and usage", async () => {
    const run = await producer(hostWithParent())
    run.replay(FOREGROUND_SUCCESS)
    expect(run.byDescription('Run echo hi command')).toMatchObject({
      membership: 'settled',
      outcome: 'succeeded',
      settledAt: T0 + 7_101,
      lastMessage: 'The command executed successfully. Output: `hi`',
      totalTokens: 16_908,
      invocation: { invocationId: 'toolu_agent', generation: 1 }
    })
    expect(run.ingested.flatMap((outcome) => outcome?.rejected ?? [])).toEqual([])
  })
})
