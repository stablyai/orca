import { finishJournalStepsAsync } from '../agent-session-journal/journal-reconstruction-steps'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { codexProviderHandle } from '../../../shared/agent-session/lifecycle/agent-session-provider-handle-encoding'

import {
  createTrackedJournalOpener,
  finishTestJournalHistoricalInputs,
  openTestJournalHostDatabase
} from '../agent-session-journal/journal-host-database-test-support'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'

import { createAgentSessionCatchUpReader } from './agent-session-history-page'

const IDENTITY = {
  sessionId: 'session-1',
  workspaceId: 'ws-1',
  hostId: 'host-1',
  agent: 'codex' as const,
  providerHandle: codexProviderHandle('thread-1')
}
const journals = createTrackedJournalOpener({ legacyInputs: true })
let root: string
let journal: AgentSessionJournal
const item = (ordinal: number) => ({
  provider: 'codex' as const,
  threadId: 'thread-1',
  turnId: 'turn-1',
  ordinal
})

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-history-public-read-'))
  journal = await journals.open({ identity: IDENTITY, stateDirectory: root })
})
afterEach(async () => {
  await journals.closeAll()
  await rm(root, { recursive: true, force: true })
})

it('refreshes a retained catch-up reader after a same-cursor disk reload', async () => {
  const options = { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
  await journal.appendItem(item(0), { kind: 'turn', turnId: 'turn-1', state: 'running' }, options)
  const view = journal.publicRead()
  expect(view.snapshot.items).toHaveLength(1)
  const cursor = journal.cursor()
  const read = createAgentSessionCatchUpReader(journal, undefined, view)
  const request = {
    sessionId: IDENTITY.sessionId,
    direction: 'after' as const,
    cursor: { epoch: cursor.epoch, sequence: 0 }
  }
  expect(await read(request)).toMatchObject({
    ok: true,
    page: { items: [{ body: { state: 'running' } }], latestTurn: { turn: { state: 'running' } } }
  })
  ;(await openTestJournalHostDatabase(root)).db
    .prepare(
      "UPDATE journal_rows SET row_json = json_set(row_json, '$.body.state', 'completed') WHERE session_id = ? AND epoch = ? AND seq = ?"
    )
    .run(IDENTITY.sessionId, cursor.epoch, cursor.sequence)
  await journal.open()
  expect(journal.cursor()).toEqual(cursor)
  expect(await read(request)).toMatchObject({
    ok: true,
    page: {
      items: [{ body: { state: 'completed' } }],
      latestTurn: { turn: { state: 'completed' } }
    }
  })
})

it('keeps a yielding snapshot coherent when a submission settles during its projection', async () => {
  finishTestJournalHistoricalInputs(journal)
  await journal.appendSubmission({
    clientMessageId: 'pending',
    payloadFingerprint: 'a'.repeat(64),
    fence: 1,
    body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'Before settlement' }] }
  })
  const before = structuredClone(journal.currentRead())
  const retained = await journal.readSinceView(
    journal.cursor(),
    100,
    () => undefined,
    async (_since, view) => {
      const steps = view.snapshotSteps()
      expect(steps.next().done).toBe(false)
      await journal.resolveDispatch({
        clientMessageId: 'pending',
        fence: 1,
        state: 'accepted',
        providerIdentity: null
      })
      return finishJournalStepsAsync(steps)
    }
  )
  expect(retained).toEqual(before)
  expect(journal.currentRead().submissions[0]?.dispatchState).toBe('accepted')
  const reopened = await journals.open({ identity: IDENTITY, stateDirectory: root })
  expect(reopened.currentRead()).toEqual(journal.currentRead())
})
