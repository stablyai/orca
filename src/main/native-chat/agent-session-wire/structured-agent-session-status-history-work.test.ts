import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { projectStructuredAgentSessionStatusState } from '../../../shared/agent-session/view/structured-agent-session-projection'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalItemBody
} from '../../../shared/agent-session/journal/agent-session-journal-types'
import { codexProviderHandle } from '../../../shared/agent-session/lifecycle/agent-session-provider-handle-encoding'
import { createTrackedJournalOpener } from '../agent-session-journal/journal-host-database-test-support'
import * as publicRead from '../agent-session-journal/journal-public-read'
import * as stopNotes from '../agent-session-journal/journal-stop-note-projection'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { StructuredAgentSessionJournalProjections } from './structured-agent-session-status-journal-projection'

// Status re-derives on every journal write while an agent streams; this pins how its work grows with history.
const journals = createTrackedJournalOpener()
let directory: string
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'orca-status-history-work-'))
})
afterEach(async () => {
  vi.restoreAllMocks()
  await journals.closeAll()
  await rm(directory, { recursive: true, force: true })
})

async function append(
  journal: AgentSessionJournal,
  id: string,
  body: AgentJournalItemBody,
  turnItemId?: string
) {
  await journal.appendItem({ provider: 'orca', clientMessageId: id }, body, {
    fence: 7,
    turnScope:
      turnItemId === undefined
        ? AGENT_JOURNAL_THREAD_SCOPE
        : { kind: 'turn', turnItemId: `orca:${turnItemId}` }
  })
}

async function turn(
  journal: AgentSessionJournal,
  id: string,
  user: AgentJournalItemBody,
  state: 'completed' | 'running'
) {
  await append(journal, `user-${id}`, user)
  await append(journal, `turn-${id}`, {
    kind: 'turn',
    turnId: id,
    state,
    ...(state === 'completed' ? { outcome: 'success' as const } : {}),
    userItemId: `orca:user-${id}`
  })
  await append(
    journal,
    `reply-${id}`,
    { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: `Reply ${id}` }] },
    `turn-${id}`
  )
}

const prompt = (text: string): AgentJournalItemBody => ({
  kind: 'message',
  role: 'user',
  blocks: [{ type: 'text', text }]
})

function openJournal(sessionId: string) {
  return journals.open({
    identity: {
      sessionId,
      workspaceId: 'workspace-1',
      hostId: 'local',
      agent: 'codex',
      providerHandle: codexProviderHandle('provider')
    },
    stateDirectory: directory,
    now: () => 100
  })
}

/** One write on a chat with `turns` finished turns behind a streaming turn, or one Orca just stopped. */
async function measure(turns: number, withCommand: boolean, stopped = false) {
  const journal = await openJournal(`session-${turns}-${withCommand}-${stopped}`)
  if (withCommand) {
    await turn(
      journal,
      'compact',
      { kind: 'message', role: 'user', blocks: [], command: { name: 'compact' } },
      'completed'
    )
  }
  for (let index = 0; index < turns; index++) {
    await turn(journal, `old-${index}`, prompt(`Old ${index}`), 'completed')
  }
  await append(journal, 'user-live', prompt('Live'))
  await append(journal, 'turn-live', {
    kind: 'turn',
    turnId: 'live',
    state: stopped ? 'interrupted' : 'running',
    userItemId: 'orca:user-live'
  })
  const projections = new StructuredAgentSessionJournalProjections()
  projections.read(journal, null)
  await append(
    journal,
    'streamed',
    stopped
      ? { kind: 'status', text: 'Stopped for an update', orcaStop: { cause: 'update' } }
      : { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'Streaming' }] },
    'turn-live'
  )

  let bodyReads = 0
  const statusRead = journal.statusRead.bind(journal)
  vi.spyOn(journal, 'statusRead').mockImplementation(() => {
    const read = statusRead()
    return {
      ...read,
      items: read.items.map((item) =>
        Object.defineProperty({ ...item }, 'body', {
          enumerable: true,
          get: () => {
            bodyReads += 1
            return item.body
          }
        })
      )
    }
  })
  const statusItem = vi.spyOn(publicRead, 'renderJournalStatusItem')
  statusItem.mockClear()
  const rendered = vi.spyOn(stopNotes, 'projectJournalStopNote')
  rendered.mockClear()
  const projection = projections.read(journal, null)
  const renders = rendered.mock.calls.length
  const snapshot = statusRead()
  return {
    bodyReads,
    renders,
    indexedReads: statusItem.mock.calls.length,
    rows: snapshot.items.length,
    state: projection.state,
    scanned: projectStructuredAgentSessionStatusState(snapshot.items, snapshot.submissions, 7)
  }
}

it.each([
  [false, false],
  [true, false],
  [true, true]
])(
  'keeps command-turn discovery off history on each write (old /compact: %s, stopped: %s)',
  async (withCommand, stopped) => {
    const small = await measure(20, withCommand, stopped)
    const large = await measure(200, withCommand, stopped)
    for (const run of [small, large]) {
      // Same status as a scan of the rows, from the few rows the indexed read reaches.
      expect(run.state).toEqual(run.scanned)
      expect(run.state.summary).toMatchObject(
        stopped
          ? { status: 'idle', turnOutcome: 'cancellation' }
          : { status: 'working', lastAssistantMessage: 'Streaming' }
      )
    }
    // Command turns are found through the indexed read, the same few rows at any history length.
    expect(small.indexedReads).toBeGreaterThan(0)
    expect(large.indexedReads).toBe(small.indexedReads)
    // The remaining derivation is linear: a fixed number of body reads per historical row.
    const perRow = (large.bodyReads - small.bodyReads) / (large.rows - small.rows)
    expect(perRow).toBeLessThanOrEqual(6)
    // The journal still renders every row once per status read; recorded here, not removed.
    for (const run of [small, large]) {
      expect(run.renders).toBe(run.rows + run.indexedReads)
    }
  }
)

it('reads a command turn from before /clear as the current context does', async () => {
  const journal = await openJournal('session-clear')
  await turn(
    journal,
    'compact',
    { kind: 'message', role: 'user', blocks: [], command: { name: 'compact' } },
    'completed'
  )
  await append(journal, 'clear', {
    kind: 'status',
    text: 'Context cleared',
    presentation: 'context-cleared',
    contextClear: { operationId: 'clear', afterFence: 7, clearedAt: 100 }
  })
  await append(
    journal,
    'late',
    { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'Late output' }] },
    'turn-compact'
  )
  const snapshot = journal.statusRead()
  const { state } = new StructuredAgentSessionJournalProjections().read(journal, null)
  expect(state).toEqual(
    projectStructuredAgentSessionStatusState(snapshot.items, snapshot.submissions, 7)
  )
  expect(state.summary.lastAssistantMessage).toBe('Late output')
})

it('keeps the interruption verdict and stays current as a command turn it skips changes', async () => {
  const journal = await openJournal('session-interrupted')
  const projections = new StructuredAgentSessionJournalProjections()
  const expectScanned = () => {
    const snapshot = journal.statusRead()
    const { state } = projections.read(journal, null)
    expect(state).toEqual(
      projectStructuredAgentSessionStatusState(snapshot.items, snapshot.submissions, 7)
    )
    return state
  }
  await append(journal, 'user-cut', prompt('Go'))
  await append(journal, 'turn-cut', {
    kind: 'turn',
    turnId: 'cut',
    state: 'interrupted',
    userItemId: 'orca:user-cut'
  })
  await append(
    journal,
    'stop-cut',
    { kind: 'status', text: 'Stopped for an update', orcaStop: { cause: 'update' } },
    'turn-cut'
  )
  const compact = {
    kind: 'message' as const,
    role: 'user' as const,
    blocks: [],
    command: { name: 'compact' }
  }
  await turn(journal, 'compact', compact, 'running')
  expectScanned()
  // The skipped command turn is revised in place: a new write, read through the same lookup.
  await append(journal, 'turn-compact', {
    kind: 'turn',
    turnId: 'compact',
    state: 'completed',
    outcome: 'success',
    userItemId: 'orca:user-compact'
  })
  const state = expectScanned()
  expect(state.summary).toMatchObject({ status: 'idle', turnOutcome: 'cancellation' })
})

it('follows a turn that becomes a command turn after it was read', async () => {
  const journal = await openJournal('session-membership')
  const projections = new StructuredAgentSessionJournalProjections()
  const read = () => {
    const snapshot = journal.statusRead()
    const { state } = projections.read(journal, null)
    expect(state).toEqual(
      projectStructuredAgentSessionStatusState(snapshot.items, snapshot.submissions, 7)
    )
    return state.summary
  }
  await append(journal, 'user-ask', prompt('Ask'))
  await append(journal, 'user-compact', {
    kind: 'message',
    role: 'user',
    blocks: [],
    command: { name: 'compact' }
  })
  const turnBody = (userItemId: string): AgentJournalItemBody => ({
    kind: 'turn',
    turnId: 'x',
    state: 'completed',
    outcome: 'success',
    userItemId
  })
  await append(journal, 'turn-x', turnBody('orca:user-ask'))
  await append(
    journal,
    'reply-x',
    { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'Answer' }] },
    'turn-x'
  )
  expect(read().lastAssistantMessage).toBe('Answer')
  // Revising the turn to the command's entry makes its reply command output, which previews skip.
  await append(journal, 'turn-x', turnBody('orca:user-compact'))
  expect(read().lastAssistantMessage).toBeUndefined()
})
