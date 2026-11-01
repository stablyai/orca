import { join } from 'node:path'
import { expect, it } from 'vitest'
import { AGENT_SESSION_JOURNAL_SCHEMA_VERSION } from '../../../shared/agent-session-journal-types'
import type { AgentSessionSubscribeEvent } from '../../../shared/agent-session-wire'
import {
  REMOTE_RUNTIME_MAX_OUTBOUND_JSON_BYTES,
  serializeRemoteRuntimePayload
} from '../../../shared/remote-runtime/remote-runtime-memory-limits'
import type { JournalRow } from '../agent-session-journal/journal-row-schema'
import {
  openTestJournalHostDatabase,
  insertTestJournalRow
} from '../agent-session-journal/journal-host-database-test-support'
import { AgentSessionSubscribers } from './structured-agent-session-subscribers'
import { codexProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'

import {
  fixture,
  SESSION,
  journals
} from './structured-agent-session-subscriber-contract-test-fixture'

it('catches a subscriber up past a pre-existing unsendable removal with a bounded reset', async () => {
  const journalDir = join(fixture.root, 'oversized-removal-journal')
  const seeded = await journals.open({
    identity: {
      sessionId: SESSION,
      workspaceId: 'workspace-1',
      hostId: 'local',
      agent: 'codex',
      providerHandle: codexProviderHandle('thread-1')
    },
    stateDirectory: journalDir
  })
  // A legacy removal ID exceeds the outbound cap alone, making catch-up impossible.
  const hugeItemId = `codex:thread-1:${'h'.repeat(5 * 1024 * 1024)}:1`
  const resumeCursor = seeded.cursor()
  const seq = resumeCursor.sequence
  const rows: JournalRow[] = [
    {
      kind: 'item',
      itemId: hugeItemId,
      revision: 1,
      body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'big' }] },
      v: AGENT_SESSION_JOURNAL_SCHEMA_VERSION,
      epoch: seeded.epoch,
      seq: seq + 1,
      fence: 1,
      ts: 2_000
    },
    {
      kind: 'tombstone',
      itemId: hugeItemId,
      revision: 2,
      v: AGENT_SESSION_JOURNAL_SCHEMA_VERSION,
      epoch: seeded.epoch,
      seq: seq + 2,
      fence: 1,
      ts: 2_001
    }
  ]
  // Direct writes model legacy persisted rows.
  await seeded.close()
  const opened = openTestJournalHostDatabase(journalDir)
  try {
    opened.db.exec('BEGIN IMMEDIATE')
    for (const row of rows) {
      insertTestJournalRow(opened.db, SESSION, row)
    }
    opened.db.exec('COMMIT')
  } finally {
    await opened.close()
  }
  const journal = await journals.open({
    identity: {
      sessionId: SESSION,
      workspaceId: 'workspace-1',
      hostId: 'local',
      agent: 'codex',
      providerHandle: codexProviderHandle('thread-1')
    },
    stateDirectory: journalDir
  })

  const subscribers = new AgentSessionSubscribers()
  const events: AgentSessionSubscribeEvent[] = []
  subscribers.open({
    id: 'subscriber-1',
    sessionId: SESSION,
    journal,
    fence: 1,
    cursor: resumeCursor,
    emit: (event) => events.push(event)
  })

  for (const event of events) {
    expect(Buffer.byteLength(serializeRemoteRuntimePayload(event), 'utf8')).toBeLessThanOrEqual(
      REMOTE_RUNTIME_MAX_OUTBOUND_JSON_BYTES
    )
  }
  const reset = events.find((event) => event.type === 'reset')
  expect(reset).toBeDefined()

  // Reset must advance past the unsendable row so later publications make progress.
  const settled = events.length
  subscribers.publish(SESSION, journal)
  expect(events.slice(settled).filter((event) => event.type === 'reset')).toEqual([])
})
