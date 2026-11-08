import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import { codexProviderHandle } from '../../../../shared/agent-session/lifecycle/agent-session-provider-handle-encoding'
import {
  createTrackedJournalOpener,
  openTestJournalHostDatabase
} from '../store-lifecycle/journal-host-database-test-support'
import { restoreJournal } from '../replay/journal-open'

const journals = createTrackedJournalOpener()
let root: string

afterEach(async () => {
  await journals.closeAll()
  await rm(root, { recursive: true, force: true })
})

it('stores a streamed reply as its first and latest text, not one copy per checkpoint', async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-journal-output-revision-'))
  let clock = 1_000
  const journal = await journals.open({
    identity: {
      sessionId: 'session-1',
      workspaceId: 'ws-1',
      hostId: 'host-1',
      agent: 'codex',
      providerHandle: codexProviderHandle('thread-1')
    },
    stateDirectory: root,
    now: () => (clock += 1),
    mintEpoch: () => 'epoch-1'
  })
  const item = { provider: 'codex', threadId: 'thread-1', turnId: 'turn-1', ordinal: 0 } as const
  for (const text of ['Hel', 'Hello', 'Hello wor', 'Hello world']) {
    await journal.appendItem(
      item,
      { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text }] },
      { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
  }
  const db = openTestJournalHostDatabase(root).db
  const stored = db
    .prepare(
      `SELECT value_json FROM journal_outcomes WHERE field = 'items' AND entry_key = ? ORDER BY seq`
    )
    .all(JSON.stringify('codex:thread-1:turn-1:0'))
    .map((row) => JSON.parse(String(row.value_json)).body.blocks[0].text)

  expect(stored).toEqual(['Hel', 'Hello world'])
  const body = restoreJournal(db, 'session-1')?.state.items.get('codex:thread-1:turn-1:0')?.body
  expect(body).toMatchObject({ blocks: [{ type: 'text', text: 'Hello world' }] })
})
