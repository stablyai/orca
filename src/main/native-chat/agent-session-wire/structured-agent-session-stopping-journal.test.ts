// "Stopping…" read straight off a journal: it holds while a person's Stop settles, and then while
// the turn it named or its settle bound still runs, whatever the Stop's answer. It reads only the
// journal's tail to tell.

import { codexProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { agentSessionFailureFact } from '../../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../../shared/agent-session-failure-words'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalItemIdentity,
  type AgentJournalRenderItem,
  type AgentJournalStatusItem
} from '../../../shared/agent-session-journal-types'
import { createTrackedJournalOpener } from '../agent-session-journal/journal-host-database-test-support'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { structuredAgentSessionStopNoteIdentity } from './structured-agent-session-command-turn'
import { structuredAgentSessionStopping } from './structured-agent-session-stopping'

const FENCE = 1
const journals = createTrackedJournalOpener()
let root: string
let journal: AgentSessionJournal

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-stopping-journal-'))
  journal = await journals.open({
    identity: {
      sessionId: 'session-1',
      workspaceId: 'workspace-1',
      hostId: 'local',
      agent: 'codex',
      providerHandle: codexProviderHandle('thread-1')
    },
    stateDirectory: join(root, 'session-1')
  })
})

afterEach(async () => {
  await journals.closeAll()
  await rm(root, { recursive: true, force: true })
})

function turnIdentity(turnId: string): AgentJournalItemIdentity {
  return { provider: 'codex', threadId: 'thread-1', turnId, ordinal: 0 }
}

function turn(turnId: string, state: 'running' | 'completed') {
  return journal.appendItem(
    turnIdentity(turnId),
    {
      kind: 'turn',
      turnId,
      state,
      startedAt: 1,
      ...(state === 'running' ? {} : { completedAt: 2 })
    },
    { fence: FENCE, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
  )
}

const unconfirmed: AgentJournalStatusItem = {
  kind: 'status',
  ...agentSessionFailureWords(agentSessionFailureFact('cancelUnconfirmed'), { surface: 'row' })
}

function stopping(): boolean {
  return structuredAgentSessionStopping(journal, journal.snapshot().items)
}

describe("a person's Stop's Stopping", () => {
  // The Stop is the person's whatever the agent answered; only the turn's end clears it.
  it('holds through an answer that says the Stop stopped nothing, until the turn ends', async () => {
    await turn('turn-1', 'running')
    await journal.appendStopEvent({ reason: 'user-stop', turnId: 'turn-1' }, FENCE)
    await journal.appendItem(structuredAgentSessionStopNoteIdentity('turn-1'), unconfirmed, {
      fence: FENCE,
      turnScope: AGENT_JOURNAL_THREAD_SCOPE
    })
    expect(stopping()).toBe(true)

    await turn('turn-1', 'completed')

    expect(stopping()).toBe(false)
  })

  it('reads only the journal from the running turn on, however long the chat before it', async () => {
    for (let index = 0; index < 40; index += 1) {
      await journal.appendItem(
        { provider: 'orca', clientMessageId: `earlier-${index}` },
        { kind: 'status', text: `earlier row ${index}` },
        { fence: FENCE, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
      )
    }
    await turn('turn-1', 'running')
    await journal.appendStopEvent({ reason: 'user-stop', turnId: 'turn-1' }, FENCE)
    const items = journal.snapshot().items
    const turnIndex = items.findIndex((item) => item.body.kind === 'turn')
    let lowestRead = items.length
    const counted: AgentJournalRenderItem[] = []
    items.forEach((item, index) =>
      Object.defineProperty(counted, index, {
        enumerable: true,
        get: () => {
          lowestRead = Math.min(lowestRead, index)
          return item
        }
      })
    )
    expect(structuredAgentSessionStopping(journal, counted)).toBe(true)
    expect(lowestRead).toBe(turnIndex)
  })

  it('holds while a Stop that named no turn settles, and after only for the turn it bound', async () => {
    await journal.appendStopEvent({ reason: 'user-stop' }, FENCE)
    const settle = journal.stopMarks.beginSettle()
    expect(stopping()).toBe(true)

    journal.stopMarks.settled(settle)
    expect(stopping()).toBe(false)
    await turn('turn-1', 'running')
    expect(stopping()).toBe(false)

    journal.stopMarks.settled(journal.stopMarks.beginSettle(), 'turn-1')
    expect(stopping()).toBe(true)
  })

  it('tells its settle readers of each edge, which writes no row and so is no commit', async () => {
    await journal.appendStopEvent({ reason: 'user-stop' }, FENCE)
    const before = journal.stopMarks.revision()
    let commits = 0
    let edges = 0
    journal.observeCommits(() => {
      commits += 1
    })
    journal.stopMarks.observeSettleEdges(() => {
      edges += 1
    })
    const cursor = journal.cursor()

    journal.stopMarks.settled(journal.stopMarks.beginSettle())

    expect(journal.stopMarks.revision()).toBe(before + 2)
    expect(edges).toBe(2)
    expect(commits).toBe(0)
    expect(journal.cursor()).toEqual(cursor)
  })
})
