import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AGENT_SESSION_JOURNAL_SCHEMA_VERSION } from '../../../shared/agent-session-journal-types'
import type {
  AgentSessionHandoffStatus,
  AgentSessionSubscribeEvent
} from '../../../shared/agent-session-wire'
import {
  REMOTE_RUNTIME_MAX_OUTBOUND_JSON_BYTES,
  serializeRemoteRuntimePayload
} from '../../../shared/remote-runtime-memory-limits'
import { openJournalDatabase } from '../agent-session-journal/journal-database'
import { journalDatabaseFile } from '../agent-session-journal/journal-paths'
import { insertJournalRow } from '../agent-session-journal/journal-row-table'
import type { JournalRow } from '../agent-session-journal/journal-row-schema'
import { createTrackedJournalOpener } from '../agent-session-journal/journal-store-test-open'
import { AgentSessionSubscribers } from './structured-agent-session-subscribers'

const SESSION = 'subscriber-session'

let root: string
const journals = createTrackedJournalOpener()

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-agent-subscribers-'))
})

afterEach(async () => {
  await journals.closeAll()
  await rm(root, { recursive: true, force: true })
})

describe('AgentSessionSubscribers', () => {
  it('publishes the current fence when a resumed cursor is already caught up', async () => {
    const journal = await journals.open({
      identity: {
        sessionId: SESSION,
        workspaceId: 'workspace-1',
        hostId: 'local',
        agent: 'codex',
        providerHandle: { kind: 'codex', threadId: 'thread-1' }
      },
      journalDir: join(root, 'checkpoint-journal')
    })
    const events: AgentSessionSubscribeEvent[] = []

    new AgentSessionSubscribers().open({
      id: 'subscriber-1',
      sessionId: SESSION,
      journal,
      fence: 7,
      cursor: journal.cursor(),
      emit: (event) => events.push(event)
    })

    expect(events).toEqual([
      {
        type: 'batch',
        sessionId: SESSION,
        batch: {
          cursor: journal.cursor(),
          items: [],
          removedItemIds: [],
          submissions: []
        },
        fence: 7
      }
    ])
  })

  it('publishes handoff-only changes without serializing a transcript snapshot', async () => {
    const journal = await journals.open({
      identity: {
        sessionId: SESSION,
        workspaceId: 'workspace-1',
        hostId: 'local',
        agent: 'codex',
        providerHandle: { kind: 'codex', threadId: 'thread-1' }
      },
      journalDir: join(root, 'journal')
    })
    const subscribers = new AgentSessionSubscribers()
    const events: AgentSessionSubscribeEvent[] = []
    subscribers.open({
      id: 'subscriber-1',
      sessionId: SESSION,
      journal,
      fence: 1,
      emit: (event) => events.push(event)
    })
    const handoff: AgentSessionHandoffStatus = {
      owner: 'native',
      direction: 'to-tui',
      phase: 'switching',
      stage: 'preparing',
      operationId: 'handoff-1'
    }

    subscribers.handoff(SESSION, 2, handoff)

    expect(events.at(-1)).toEqual({
      type: 'batch',
      sessionId: SESSION,
      batch: {
        cursor: journal.cursor(),
        items: [],
        removedItemIds: [],
        submissions: []
      },
      fence: 2,
      handoff
    })
  })

  it('publishes background lifecycle without advancing the journal and carries its fence forward', async () => {
    const journal = await journals.open({
      identity: {
        sessionId: SESSION,
        workspaceId: 'workspace-1',
        hostId: 'local',
        agent: 'claude',
        providerHandle: { kind: 'claude', sessionId: 'provider-1', leafUuid: null }
      },
      journalDir: join(root, 'background-journal')
    })
    const subscribers = new AgentSessionSubscribers()
    const events: AgentSessionSubscribeEvent[] = []
    subscribers.open({
      id: 'subscriber-1',
      sessionId: SESSION,
      journal,
      fence: 1,
      backgroundTasks: null,
      emit: (event) => events.push(event)
    })
    const cursor = journal.cursor()

    const backgroundTasks = {
      state: 'monitoring' as const,
      tasks: [{ id: 'task-1', kind: 'command' as const, description: 'run the build' }]
    }
    subscribers.backgroundTasks(SESSION, backgroundTasks, 2)

    expect(journal.cursor()).toEqual(cursor)
    expect(events.at(-1)).toEqual({
      type: 'batch',
      sessionId: SESSION,
      batch: { cursor, items: [], removedItemIds: [], submissions: [] },
      fence: 2,
      backgroundTasks
    })

    await journal.appendItem(
      { provider: 'orca', clientMessageId: 'after-background-fence' },
      { kind: 'status', text: 'After background state' },
      { fence: 2 }
    )
    subscribers.publish(SESSION, journal)

    expect(events.at(-1)).toMatchObject({ type: 'batch', fence: 2 })
  })

  it('catches a subscriber up past a pre-existing unsendable removal with a bounded reset', async () => {
    const journalDir = join(root, 'oversized-removal-journal')
    const seeded = await journals.open({
      identity: {
        sessionId: SESSION,
        workspaceId: 'workspace-1',
        hostId: 'local',
        agent: 'codex',
        providerHandle: { kind: 'codex', threadId: 'thread-1' }
      },
      journalDir
    })
    // A row admitted before identity bounding: its removal id alone exceeds
    // the outbound cap, so no catch-up batch can ever carry it.
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
    // Staged straight into the session database, exactly as a previous writer
    // would have committed them.
    await seeded.close()
    const opened = openJournalDatabase(journalDatabaseFile(journalDir))
    try {
      opened.db.exec('BEGIN IMMEDIATE')
      for (const row of rows) {
        insertJournalRow(opened.db, SESSION, row)
      }
      opened.db.exec('COMMIT')
    } finally {
      opened.db.close()
    }
    const journal = await journals.open({
      identity: {
        sessionId: SESSION,
        workspaceId: 'workspace-1',
        hostId: 'local',
        agent: 'codex',
        providerHandle: { kind: 'codex', threadId: 'thread-1' }
      },
      journalDir
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

    // Every event a remote subscriber receives must fit the outbound channel.
    for (const event of events) {
      expect(Buffer.byteLength(serializeRemoteRuntimePayload(event), 'utf8')).toBeLessThanOrEqual(
        REMOTE_RUNTIME_MAX_OUTBOUND_JSON_BYTES
      )
    }
    const reset = events.find((event) => event.type === 'reset')
    expect(reset).toBeDefined()

    // Forward progress: the reset advanced the subscriber past the unsendable
    // row, so the next publish has nothing stale to re-deliver.
    const settled = events.length
    subscribers.publish(SESSION, journal)
    expect(events.slice(settled).filter((event) => event.type === 'reset')).toEqual([])
  })
})
