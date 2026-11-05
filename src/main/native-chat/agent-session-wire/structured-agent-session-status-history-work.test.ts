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

/** One streamed write on a chat with `turns` finished turns behind a running one. */
async function measure(turns: number, withCommand: boolean) {
  const journal = await journals.open({
    identity: {
      sessionId: `session-${turns}-${withCommand}`,
      workspaceId: 'workspace-1',
      hostId: 'local',
      agent: 'codex',
      providerHandle: codexProviderHandle('provider')
    },
    stateDirectory: directory,
    now: () => 100
  })
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
  await turn(journal, 'live', prompt('Live'), 'running')
  const projections = new StructuredAgentSessionJournalProjections()
  projections.read(journal, null)
  await append(
    journal,
    'streamed',
    { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'Streaming' }] },
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
  const projection = projections.read(journal, null)
  const snapshot = statusRead()
  return {
    bodyReads,
    indexedReads: statusItem.mock.calls.length,
    rows: snapshot.items.length,
    state: projection.state,
    scanned: projectStructuredAgentSessionStatusState(snapshot.items, snapshot.submissions, 7)
  }
}

it.each([false, true])(
  'keeps command-turn discovery off history on each streamed write (old /compact: %s)',
  async (withCommand) => {
    const small = await measure(20, withCommand)
    const large = await measure(200, withCommand)
    for (const run of [small, large]) {
      // Same status as a scan of the rows, from the few rows the indexed read reaches.
      expect(run.state).toEqual(run.scanned)
      expect(run.state.summary).toMatchObject({
        status: 'working',
        lastAssistantMessage: 'Streaming'
      })
    }
    // Command turns are found through the indexed read, the same few rows at any history length.
    expect(small.indexedReads).toBeGreaterThan(0)
    expect(large.indexedReads).toBe(small.indexedReads)
    // The remaining derivation is linear: a fixed number of body reads per historical row.
    const perRow = (large.bodyReads - small.bodyReads) / (large.rows - small.rows)
    expect(perRow).toBeLessThanOrEqual(6)
  }
)
