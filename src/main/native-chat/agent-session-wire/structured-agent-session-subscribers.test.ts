import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  AGENT_JOURNAL_RESET_REASONS,
  AGENT_SESSION_JOURNAL_SCHEMA_VERSION
} from '../../../shared/agent-session-journal-types'
import type {
  AgentSessionHandoffStatus,
  AgentSessionStatusEvent,
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
import { StructuredAgentSessionStatusFeed } from './structured-agent-session-status-feed'
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
  // The reason reaches paired and mobile decoders that may reject a value they
  // have never seen, so the recovery that caused the reset rides beside it.
  it('names the recovery cause without widening the reset reason', async () => {
    const journal = await journals.open({
      identity: {
        sessionId: SESSION,
        workspaceId: 'workspace-1',
        hostId: 'local',
        agent: 'codex',
        providerHandle: { kind: 'codex', threadId: 'thread-1' }
      },
      journalDir: join(root, 'reset-cause-journal')
    })
    const events: AgentSessionSubscribeEvent[] = []
    const subscribers = new AgentSessionSubscribers()
    subscribers.open({
      id: 'subscriber-1',
      sessionId: SESSION,
      journal,
      fence: 3,
      emit: (event) => events.push(event)
    })

    subscribers.reset(SESSION, journal, 'epoch_changed', 3, 'journal_missing')
    subscribers.reset(SESSION, journal, 'epoch_changed', 3)

    const resets = events.filter((event) => event.type === 'reset')
    expect(resets).toHaveLength(2)
    expect(resets[0]).toMatchObject({ reset: 'epoch_changed', resetCause: 'journal_missing' })
    expect(AGENT_JOURNAL_RESET_REASONS).toContain(resets[0]?.reset)
    // Absent, not null, when the host has no cause to name.
    expect(resets[1] && 'resetCause' in resets[1]).toBe(false)
  })

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
        fence: 7,
        hostNow: expect.any(Number),
        activity: null
      }
    ])
  })

  it('stamps the host clock once per published frame', async () => {
    const journal = await journals.open({
      identity: {
        sessionId: SESSION,
        workspaceId: 'workspace-1',
        hostId: 'local',
        agent: 'codex',
        providerHandle: { kind: 'codex', threadId: 'thread-1' }
      },
      journalDir: join(root, 'clock-journal')
    })
    let now = 1_000
    const events: AgentSessionSubscribeEvent[] = []
    const subscribers = new AgentSessionSubscribers({ now: () => (now += 1) })
    const emit = (event: AgentSessionSubscribeEvent): void => {
      events.push(event)
    }
    subscribers.open({ id: 'one', sessionId: SESSION, journal, fence: 1, emit })
    subscribers.open({ id: 'two', sessionId: SESSION, journal, fence: 1, emit })
    await journal.appendItem(
      { provider: 'orca', clientMessageId: 'clocked' },
      { kind: 'status', text: 'Clocked' },
      { fence: 1 }
    )
    subscribers.publish(SESSION, journal)
    subscribers.handoff(SESSION, 1, { owner: 'native' } as AgentSessionHandoffStatus)
    subscribers.reset(SESSION, journal, 'epoch_changed', 1)

    expect(events.map((event) => ('hostNow' in event ? event.hostNow : null))).toEqual([
      1_001, 1_002,
      // Both subscribers of one publication read the same clock sample.
      1_003, 1_003, 1_004, 1_004, 1_005, 1_005
    ])
    expect(events.map((event) => event.type)).toEqual([
      'snapshot',
      'snapshot',
      'batch',
      'batch',
      'batch',
      'batch',
      'reset',
      'reset'
    ])
  })

  it('includes catalogs on reconnect and sends an idle checkpoint without journal work', async () => {
    const journal = await journals.open({
      identity: {
        sessionId: SESSION,
        workspaceId: 'workspace-1',
        hostId: 'local',
        agent: 'codex',
        providerHandle: { kind: 'codex', threadId: 'thread-1' }
      },
      journalDir: join(root, 'catalog-journal')
    })
    let commands = [{ name: 'first', kind: 'skill' as const }]
    const events: AgentSessionSubscribeEvent[] = []
    const subscribers = new AgentSessionSubscribers({ readCommands: () => commands })
    subscribers.open({
      id: 'one',
      sessionId: SESSION,
      journal,
      fence: 7,
      emit: (event) => events.push(event)
    })
    expect(events[0]).toMatchObject({ type: 'snapshot', commands })
    commands = [{ name: 'second', kind: 'skill' as const }]
    subscribers.publish(SESSION, journal)
    expect(events[1]).toEqual({
      type: 'batch',
      sessionId: SESSION,
      fence: 7,
      hostNow: expect.any(Number),
      commands,
      batch: { cursor: journal.cursor(), items: [], removedItemIds: [], submissions: [] }
    })
    subscribers.open({
      id: 'two',
      sessionId: SESSION,
      journal,
      cursor: journal.cursor(),
      fence: 7,
      emit: (event) => events.push(event)
    })
    expect(events[2]).toMatchObject({ type: 'batch', commands })
  })

  it('reports every content publication to the journal hook, subscribed or not', async () => {
    const journal = await journals.open({
      identity: {
        sessionId: SESSION,
        workspaceId: 'workspace-1',
        hostId: 'local',
        agent: 'codex',
        providerHandle: { kind: 'codex', threadId: 'thread-1' }
      },
      journalDir: join(root, 'hook-journal')
    })
    const published: string[] = []
    const subscribers = new AgentSessionSubscribers({
      onJournalPublished: (sessionId, published_journal) => {
        expect(published_journal).toBe(journal)
        published.push(sessionId)
      }
    })

    subscribers.publish(SESSION, journal)
    subscribers.reset(SESSION, journal, 'epoch_changed', 1)
    subscribers.snapshot(SESSION, journal, 1)
    subscribers.handoff(SESSION, 1, {
      owner: 'native',
      direction: null,
      phase: 'idle',
      stage: null,
      operationId: null
    })

    expect(published).toEqual([SESSION, SESSION, SESSION])
  })

  it('settles a session nobody is reading, from running to idle', async () => {
    // The defect this whole feed exists for: status used to come from a transcript reader, so a
    // session with no open pane had no reader and froze on whatever it last said. Nothing here
    // ever calls `subscribers.open`.
    const journal = await journals.open({
      identity: {
        sessionId: SESSION,
        workspaceId: 'workspace-1',
        hostId: 'local',
        agent: 'codex',
        providerHandle: { kind: 'codex', threadId: 'thread-1' }
      },
      journalDir: join(root, 'unread-journal')
    })
    const statusFeed = new StructuredAgentSessionStatusFeed({
      sessions: new Map([
        [
          SESSION,
          { journal, params: { location: { workspaceId: 'workspace-1' }, provider: 'codex' } }
        ]
      ]),
      getRecord: () => null,
      now: () => 1_000
    })
    const subscribers = new AgentSessionSubscribers({
      onJournalPublished: (sessionId, published) => statusFeed.publish(sessionId, published)
    })
    const statuses: AgentSessionStatusEvent[] = []
    statusFeed.subscribe({ id: 'session-list', emit: (event) => statuses.push(event) })
    const turn = { provider: 'codex', threadId: 'thread-1', turnId: 'turn-1', ordinal: 0 } as const

    await journal.appendItem(
      { ...turn, ordinal: 1 },
      { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'write a poem' }] },
      { fence: 1 }
    )
    await journal.appendItem(
      turn,
      { kind: 'status', text: 'Working', turnLifecycle: { turnId: 'turn-1', state: 'running' } },
      { fence: 1 }
    )
    subscribers.publish(SESSION, journal)

    expect(statuses.at(-1)).toEqual({
      type: 'status',
      session: expect.objectContaining({ status: 'working', latestPrompt: 'write a poem' })
    })

    await journal.appendTombstone(turn, { fence: 1 })
    subscribers.publish(SESSION, journal)

    expect(statuses.at(-1)).toEqual({
      type: 'status',
      session: expect.objectContaining({ status: 'idle' })
    })
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
      hostNow: expect.any(Number),
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
      hostNow: expect.any(Number),
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

  it('publishes latest turn activity without advancing or adding journal rows', async () => {
    const journal = await journals.open({
      identity: {
        sessionId: SESSION,
        workspaceId: 'workspace-1',
        hostId: 'local',
        agent: 'codex',
        providerHandle: { kind: 'codex', threadId: 'thread-1' }
      },
      journalDir: join(root, 'activity-journal')
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
    const cursor = journal.cursor()

    subscribers.publish(SESSION, journal, {
      turnId: 'turn-1',
      text: 'Inspecting the session wire'
    })

    expect(journal.cursor()).toEqual(cursor)
    expect(events.at(-1)).toEqual({
      type: 'batch',
      sessionId: SESSION,
      batch: { cursor, items: [], removedItemIds: [], submissions: [] },
      fence: 1,
      hostNow: expect.any(Number),
      activity: { turnId: 'turn-1', text: 'Inspecting the session wire' }
    })

    subscribers.close(SESSION, 'subscriber-1')
    subscribers.publish(SESSION, journal, null)
    subscribers.open({
      id: 'reconnected',
      sessionId: SESSION,
      journal,
      fence: 1,
      cursor,
      emit: (event) => events.push(event)
    })
    expect(journal.cursor()).toEqual(cursor)
    expect(events.at(-1)).toMatchObject({ activity: null })
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
