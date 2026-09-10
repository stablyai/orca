import { describe, expect, it, vi } from 'vitest'
import type { AgentJournalItemBody } from '../../shared/agent-session-journal-types'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { CodexJournalGenericFrames } from './codex-structured-journal-generic-frames'

const THREAD = '01a08cc2-f96e-76d0-bb74-88b9bc0b03fc'

function goalFrame(goal: Record<string, unknown>): Record<string, unknown> {
  return {
    threadId: THREAD,
    turnId: '01a08cc2-fa6a-7541-a4c7-67d98a6e40c2',
    goal: {
      threadId: THREAD,
      objective: 'Keep the current scratch directory tidy.',
      status: 'active',
      tokenBudget: null,
      tokensUsed: 0,
      timeUsedSeconds: 0,
      createdAt: 1789067988,
      updatedAt: 1789067988,
      ...goal
    }
  }
}

function frames(): { rows: AgentJournalItemBody[]; frames: CodexJournalGenericFrames } {
  const rows: AgentJournalItemBody[] = []
  const sink = {
    appendItem: (_identity: unknown, body: AgentJournalItemBody) => {
      rows.push(body)
    },
    publish: vi.fn()
  } as unknown as StructuredAgentSessionEventSink
  return { rows, frames: new CodexJournalGenericFrames({ sink }, () => null) }
}

function texts(rows: AgentJournalItemBody[]): string[] {
  return rows.map((row) => (row as { text?: string }).text ?? '')
}

describe('codex goal frames as journal rows', () => {
  it('writes one row when the goal appears', () => {
    const { rows, frames: generic } = frames()

    generic.appendUnhandled('notification:thread/goal/updated', goalFrame({}), THREAD)

    expect(texts(rows)).toEqual(['Goal set: Keep the current scratch directory tidy.'])
  })

  it('does not repeat the row while only the counters climb', () => {
    const { rows, frames: generic } = frames()

    // Codex re-sends the goal through the turn as accounting ticks; a live session
    // emitted these two seconds apart with nothing else changed.
    generic.appendUnhandled('notification:thread/goal/updated', goalFrame({}), THREAD)
    generic.appendUnhandled(
      'notification:thread/goal/updated',
      goalFrame({ tokensUsed: 23869, timeUsedSeconds: 8, updatedAt: 1789067905 }),
      THREAD
    )
    generic.appendUnhandled(
      'notification:thread/goal/updated',
      goalFrame({ tokensUsed: 25999, timeUsedSeconds: 12, updatedAt: 1789067912 }),
      THREAD
    )

    expect(rows).toHaveLength(1)
  })

  it('writes a second row when the status changes', () => {
    const { rows, frames: generic } = frames()

    generic.appendUnhandled('notification:thread/goal/updated', goalFrame({}), THREAD)
    generic.appendUnhandled(
      'notification:thread/goal/updated',
      goalFrame({ status: 'complete', tokensUsed: 31_000 }),
      THREAD
    )

    expect(texts(rows)).toEqual([
      'Goal set: Keep the current scratch directory tidy.',
      'Goal complete: Keep the current scratch directory tidy.'
    ])
  })

  it('writes a row when the objective is replaced', () => {
    const { rows, frames: generic } = frames()

    generic.appendUnhandled('notification:thread/goal/updated', goalFrame({}), THREAD)
    generic.appendUnhandled(
      'notification:thread/goal/updated',
      goalFrame({ objective: 'Ship the parser.' }),
      THREAD
    )

    expect(texts(rows)).toEqual([
      'Goal set: Keep the current scratch directory tidy.',
      'Goal set: Ship the parser.'
    ])
  })

  it('writes a row when the goal is cleared, and again if a new goal follows', () => {
    const { rows, frames: generic } = frames()

    generic.appendUnhandled('notification:thread/goal/updated', goalFrame({}), THREAD)
    generic.appendUnhandled('notification:thread/goal/cleared', { threadId: THREAD }, THREAD)
    generic.appendUnhandled(
      'notification:thread/goal/updated',
      goalFrame({ objective: 'Ship the parser.' }),
      THREAD
    )

    expect(texts(rows)).toEqual([
      'Goal set: Keep the current scratch directory tidy.',
      'Goal cleared',
      'Goal set: Ship the parser.'
    ])
  })

  it('keeps each thread’s goal separate', () => {
    const { rows, frames: generic } = frames()
    const other = '01a08cc3-0000-7000-8000-000000000000'

    generic.appendUnhandled('notification:thread/goal/updated', goalFrame({}), THREAD)
    generic.appendUnhandled('notification:thread/goal/updated', goalFrame({}), other)

    expect(rows).toHaveLength(2)
  })

  it('leaves non-goal frames to the existing path', () => {
    const { rows, frames: generic } = frames()

    generic.appendUnhandled('notification:warning', { message: 'disk almost full' }, THREAD)
    generic.appendUnhandled('notification:warning', { message: 'disk almost full' }, THREAD)

    // No goal dedupe applies, so both warnings still land.
    expect(rows).toHaveLength(2)
  })
})
