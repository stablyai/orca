// What a subagent may and may not say about the session that spawned it, as this feed
// publishes it.
//
// One journal holds the session's own agent's rows and every descendant's. The status
// summary is the session's row in every list that renders one, so the split matters here:
// a child's frames must not move the session's recency clock, and a child that is still
// working must still keep the session's row from reading finished.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentSessionBackgroundTask } from '../../../shared/agent-session-wire'
import { createStatusFeedTestBed } from './structured-agent-session-status-feed-test-bed'

const SESSION = 'status-session'
const USER_IDENTITY = {
  provider: 'codex',
  threadId: 'thread-1',
  turnId: 'turn-1',
  ordinal: 1
} as const

const { open, close, openJournal, feedFor } = createStatusFeedTestBed(SESSION)

beforeEach(open)
afterEach(close)

describe('a subagent and the status summary of the session that spawned it', () => {
  it("holds an idle session's clock and its publications while a subagent's rows land", async () => {
    // An explicit, always-advancing journal clock. On the wall clock five appends can share
    // a millisecond, and a `Math.max` over the same number moves nothing — the test would
    // pass against an unattributed clock and prove nothing.
    let appendedAt = 10_000
    const journal = await openJournal(SESSION, () => (appendedAt += 1_000))
    const { feed, events } = feedFor(new Map([[SESSION, { journal }]]))
    await journal.appendItem(
      USER_IDENTITY,
      { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'fan out' }] },
      { fence: 1 }
    )
    feed.publish(SESSION, journal)
    const settled = events.at(-1)
    if (settled?.type !== 'status') {
      throw new Error('status publication missing')
    }
    expect(settled.session.status).toBe('idle')
    const published = events.length

    for (let row = 0; row < 5; row += 1) {
      await journal.appendItem(
        { provider: 'claude', sessionId: 'claude-session', uuid: `child-${row}` },
        { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: `reading ${row}` }] },
        { fence: 1, producedBySubagent: true }
      )
      feed.publish(SESSION, journal)
    }

    // The clock is the session's own. `summariesEqual` treats `updatedAt` as significant
    // only while idle, so an idle parent with a working child is the exact case where a
    // contaminated clock re-broadcasts the whole summary to every subscriber, local and
    // remote, once per child frame.
    expect(events).toHaveLength(published)
    const latest = events.at(-1)
    if (latest?.type !== 'status') {
      throw new Error('status publication missing')
    }
    expect(latest.session.updatedAt).toBe(settled.session.updatedAt)
  })

  it('reads a session with a working subagent as working, without moving its clock', async () => {
    let appendedAt = 10_000
    const journal = await openJournal(SESSION, () => (appendedAt += 1_000))
    let tasks: AgentSessionBackgroundTask[] = [
      { id: 'child-1', kind: 'agent', name: 'deep_review', state: 'working' }
    ]
    const { feed, events } = feedFor(new Map([[SESSION, { journal }]]), null, undefined, () => ({
      state: 'monitoring',
      tasks
    }))
    await journal.appendItem(
      USER_IDENTITY,
      { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'fan out' }] },
      { fence: 1 }
    )
    feed.publish(SESSION, journal)
    const busy = events.at(-1)
    if (busy?.type !== 'status') {
      throw new Error('status publication missing')
    }
    // The session's own agent has settled; its child has not. The row reads busy off the
    // rollup, and off nothing else — the clock stays the parent's own last row.
    expect(busy.session.status).toBe('working')
    expect(busy.session.updatedAt).toBe(journal.lastActivityAt())
    // Rolled-up work is the child's, so the parent's row claims no tool of its own.
    expect(busy.session.toolName).toBeUndefined()

    // A backgrounded shell is not a subagent, and a settled child is not working.
    tasks = [{ id: 'shell-1', kind: 'command', state: 'working' }]
    feed.publish(SESSION, journal)
    expect(events.at(-1)).toMatchObject({ type: 'status', session: { status: 'idle' } })
    tasks = [{ id: 'child-1', kind: 'agent', name: 'deep_review', state: 'done' }]
    feed.publish(SESSION, journal)
    expect(events.at(-1)).toMatchObject({ type: 'status', session: { status: 'idle' } })
  })
})
