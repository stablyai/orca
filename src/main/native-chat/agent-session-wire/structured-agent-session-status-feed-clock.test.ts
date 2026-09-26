import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
// Which journal changes republish a session's status now that the summary carries its own state
// clock: a moved clock always does, and row activity alone does not once the clock dates the state.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type {
  AgentJournalItemBody,
  AgentJournalItemIdentity
} from '../../../shared/agent-session-journal-types'
import type { AgentSessionStatusSummary } from '../../../shared/agent-session-wire'
import { createTrackedJournalOpener } from '../agent-session-journal/journal-store-test-open'
import { StructuredAgentSessionStatusFeed } from './structured-agent-session-status-feed'
import { indexedStatusFeedSession } from './structured-agent-session-status-feed-test-session'

const SESSION = 'clock-session'
const THREAD = 'thread-1'

let root: string
const journals = createTrackedJournalOpener()

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-status-feed-clock-'))
})

afterEach(async () => {
  await journals.closeAll()
  await rm(root, { recursive: true, force: true })
})

function codexItem(ordinal: number): AgentJournalItemIdentity {
  return { provider: 'codex', threadId: THREAD, turnId: 'turn-1', ordinal }
}

function approval(title: string, answered = false): AgentJournalItemBody {
  return {
    kind: 'approval',
    title,
    detail: null,
    options: [{ id: 'yes', label: 'Allow' }],
    resolution: answered
      ? { state: 'resolved', selectedOptionId: 'yes', resolvedBy: 'user', resolvedAt: 2 }
      : { state: 'pending', selectedOptionId: null, resolvedBy: null, resolvedAt: null }
  }
}

async function openFeed() {
  let clock = 1_000
  const journal = await journals.open({
    identity: {
      sessionId: SESSION,
      workspaceId: 'workspace-1',
      hostId: 'local',
      agent: 'codex',
      providerHandle: { kind: 'codex', threadId: THREAD }
    },
    now: () => (clock += 100),
    journalDir: join(root, SESSION)
  })
  const feed = new StructuredAgentSessionStatusFeed({
    sessions: new Map([[SESSION, indexedStatusFeedSession({ journal })]]),
    getRecord: () => null,
    now: () => clock
  })
  const published: AgentSessionStatusSummary[] = []
  feed.subscribe({
    id: 'list-1',
    emit: (event) => {
      if (event.type === 'status') {
        published.push(event.session)
      }
    }
  })
  const write = async (identity: AgentJournalItemIdentity, body: AgentJournalItemBody) => {
    await journal.appendItem(identity, body, { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE })
    feed.publish(SESSION, journal)
  }
  await write(
    { provider: 'orca', clientMessageId: 'prompt-1' },
    { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'go' }] }
  )
  return { published, write }
}

describe('status republication and the state clock', () => {
  it('stays quiet for activity on a dated idle session, and speaks when the clock moves', async () => {
    const { published, write } = await openFeed()
    await write(codexItem(0), {
      kind: 'turn',
      turnId: 'turn-1',
      state: 'completed',
      completedAt: 1_150
    })
    const settled = published.length
    expect(published.at(-1)).toMatchObject({ status: 'idle', statusStartedAt: 1_150 })

    // A roster-style revision: new journal activity, same words, same clock.
    await write(codexItem(5), { kind: 'status', text: 'Subagent running' })
    await write(codexItem(5), { kind: 'status', text: 'Subagent running' })
    expect(published).toHaveLength(settled)

    await write(codexItem(0), {
      kind: 'turn',
      turnId: 'turn-1',
      state: 'completed',
      completedAt: 1_900
    })
    expect(published.at(-1)).toMatchObject({ status: 'idle', statusStartedAt: 1_900 })
  })

  it('republishes an attention clock that moves while the session stays in attention', async () => {
    const { published, write } = await openFeed()
    await write(codexItem(0), {
      kind: 'turn',
      turnId: 'turn-1',
      state: 'running',
      startedAt: 1_100
    })
    await write(codexItem(1), approval('first'))
    const first = published.at(-1)?.statusStartedAt
    await write(codexItem(2), approval('second'))
    const second = published.at(-1)
    expect(second).toMatchObject({ status: 'attention', statusStartedAt: first })

    await write(codexItem(1), approval('first', true))
    expect(published.at(-1)).toMatchObject({ status: 'attention' })
    expect(published.at(-1)?.statusStartedAt).toBeGreaterThan(first ?? Infinity)
  })
})
