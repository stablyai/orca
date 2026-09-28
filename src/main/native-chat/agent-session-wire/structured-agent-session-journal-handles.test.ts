// Journal handle ownership across the wire layer.
//
// Every one of these sites is reached only when something has already gone
// wrong, so a happy-path assertion proves nothing about them. On POSIX a leak
// is silent; the rename/remove pair below is the half that actually fails on
// Windows.

import { access, mkdtemp, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionJournalIdentity } from '../../../shared/agent-session-journal-types'
import type * as JournalLegacyImport from '../agent-session-journal/journal-legacy-import'
import { journalDatabaseFile } from '../agent-session-journal/journal-paths'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { createTrackedJournalOpener } from '../agent-session-journal/journal-store-test-open'
import { openAgentSessionJournalWithRecovery } from './agent-session-journal-recovery'
import { closeStructuredAgentSessionConversationUnderSerialize } from './structured-agent-session-host-lifetime'
import { tearDownStructuredAgentSessionHost } from './structured-agent-session-host-teardown'
import type { StructuredAgentSessionHostSession } from './structured-agent-session-host-types'

const legacyImport = vi.hoisted(() => ({ throws: false }))

vi.mock('../agent-session-journal/journal-legacy-import', async (importOriginal) => {
  const actual = await importOriginal<typeof JournalLegacyImport>()
  return {
    ...actual,
    importLegacyTranscriptIntoJournal: async (
      input: Parameters<typeof actual.importLegacyTranscriptIntoJournal>[0]
    ) => {
      if (legacyImport.throws) {
        throw new Error('legacy import threw instead of reporting a failure')
      }
      return actual.importLegacyTranscriptIntoJournal(input)
    }
  }
})

const SESSION = '019fd532-7c11-7a90-b6de-4e1a2c3d5f60'

const IDENTITY: AgentSessionJournalIdentity = {
  sessionId: SESSION,
  workspaceId: 'ws-1',
  hostId: 'host-1',
  agent: 'codex',
  providerHandle: { kind: 'codex', threadId: SESSION }
}

let root: string
let journalDir: string
const journals = createTrackedJournalOpener()

async function exists(path: string): Promise<boolean> {
  return access(path)
    .then(() => true)
    .catch(() => false)
}

async function expectNothingHoldsTheDirectory(directory: string): Promise<void> {
  const dbPath = journalDatabaseFile(directory)
  expect(await exists(`${dbPath}-wal`)).toBe(false)
  expect(await exists(`${dbPath}-shm`)).toBe(false)
  const moved = `${directory}-moved`
  await rename(directory, moved)
  await rm(moved, { recursive: true })
}

function hostSession(journal: AgentSessionJournal): StructuredAgentSessionHostSession {
  return {
    journal,
    params: {} as StructuredAgentSessionHostSession['params'],
    child: null
  }
}

beforeEach(async () => {
  legacyImport.throws = false
  root = await mkdtemp(join(tmpdir(), 'orca-wire-handles-'))
  journalDir = join(root, 'journal')
})

afterEach(async () => {
  await journals.closeAll()
  await rm(root, { recursive: true, force: true })
})

describe('site 6: recovery rehydration', () => {
  it('closes the journal it opened when the legacy import throws', async () => {
    const seeded = await journals.open({ identity: IDENTITY, journalDir })
    for (let ordinal = 1; ordinal <= 3; ordinal += 1) {
      await seeded.appendItem(
        { provider: 'codex', threadId: SESSION, turnId: 'turn-1', ordinal },
        { kind: 'status', text: `seed-${ordinal}` },
        { fence: 1 }
      )
    }
    await seeded.close()
    // Punch a hole in the middle so recovery takes the `journal_corrupt` branch.
    const { openJournalDatabase } = await import('../agent-session-journal/journal-database')
    const opened = openJournalDatabase(journalDatabaseFile(journalDir))
    opened.db.prepare('DELETE FROM journal_rows WHERE seq = ?').run(3)
    opened.db.close()
    legacyImport.throws = true

    await expect(
      openAgentSessionJournalWithRecovery({
        identity: IDENTITY,
        journalDir,
        fence: 1,
        historyFilePath: join(root, 'missing.jsonl')
      })
    ).rejects.toThrow('legacy import threw')
    await expectNothingHoldsTheDirectory(journalDir)
  })
})

describe('sites 9 and 10: closing a conversation handle', () => {
  it('drops the map entry before the close, and releases the handle', async () => {
    const journal = await journals.open({ identity: IDENTITY, journalDir })
    const sessions = new Map([[SESSION, hostSession(journal)]])
    const order: string[] = []
    const close = journal.close.bind(journal)
    journal.close = async () => {
      // A lock-free reader arriving now must find no entry, never a closing handle.
      order.push(sessions.has(SESSION) ? 'close-while-indexed' : 'close-after-delete')
      await close()
      order.push('closed')
    }

    await expect(
      closeStructuredAgentSessionConversationUnderSerialize(
        { sessions, closeStatus: () => order.push('status') },
        SESSION
      )
    ).resolves.toBe(true)

    expect(order).toEqual(['status', 'close-after-delete', 'closed'])
    expect(sessions.size).toBe(0)
    await expectNothingHoldsTheDirectory(journalDir)
  })

  it('surfaces a rejected close to its caller', async () => {
    const journal = await journals.open({ identity: IDENTITY, journalDir })
    const sessions = new Map([[SESSION, hostSession(journal)]])
    const close = journal.close.bind(journal)
    journal.close = () => Promise.reject(new Error('close rejected'))

    await expect(
      closeStructuredAgentSessionConversationUnderSerialize(
        { sessions, closeStatus: () => undefined },
        SESSION
      )
    ).rejects.toThrow('close rejected')
    journal.close = close
  })
})

describe('site 11: host teardown is failure-complete', () => {
  async function twoSessions(): Promise<Map<string, StructuredAgentSessionHostSession>> {
    const first = await journals.open({ identity: IDENTITY, journalDir })
    const second = await journals.open({
      identity: { ...IDENTITY, sessionId: `${SESSION}-b` },
      journalDir: join(root, 'journal-b')
    })
    return new Map([
      [SESSION, hostSession(first)],
      [`${SESSION}-b`, hostSession(second)]
    ])
  }

  it('closes every journal and clears the map on the happy path', async () => {
    const sessions = await twoSessions()
    const acknowledgeSessionRelease = vi.fn()
    await tearDownStructuredAgentSessionHost({
      phases: [],
      sessions,
      acknowledgeSessionRelease
    })

    expect(sessions.size).toBe(0)
    expect(acknowledgeSessionRelease.mock.calls).toEqual([[SESSION], [`${SESSION}-b`]])
    await expectNothingHoldsTheDirectory(journalDir)
    await expectNothingHoldsTheDirectory(join(root, 'journal-b'))
  })

  // Against a trailing-statement design this case fails: `flushAllEventSinks`
  // throws by design, so the close would be skipped on exactly the leaking path.
  it('still closes every journal when a teardown phase throws', async () => {
    const sessions = await twoSessions()
    const barrierError = new Error('sink barrier failed')

    await expect(
      tearDownStructuredAgentSessionHost({
        phases: [
          {
            name: 'flush-event-sinks',
            run: () => {
              throw barrierError
            }
          }
        ],
        sessions
      })
    ).rejects.toMatchObject({ errors: [barrierError] })

    expect(sessions.size).toBe(0)
    await expectNothingHoldsTheDirectory(journalDir)
    await expectNothingHoldsTheDirectory(join(root, 'journal-b'))
  })

  it('keeps the entry whose close rejected, and surfaces the rejection', async () => {
    const sessions = await twoSessions()
    const acknowledgeSessionRelease = vi.fn()
    const failing = sessions.get(SESSION)
    const closeError = new Error('close rejected')
    if (failing) {
      sessions.set(SESSION, {
        ...failing,
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: teardown calls only `close`, and this map is a plain `Map` that binds no delivery.
        journal: {
          close: () => Promise.reject(closeError)
        } as unknown as AgentSessionJournal
      })
    }

    await expect(
      tearDownStructuredAgentSessionHost({ phases: [], sessions, acknowledgeSessionRelease })
    ).rejects.toMatchObject({ errors: [closeError] })

    // Only the failure stays indexed — `status === 'fulfilled'`, not "settled".
    expect([...sessions.keys()]).toEqual([SESSION])
    expect(acknowledgeSessionRelease).toHaveBeenCalledExactlyOnceWith(`${SESSION}-b`)
    await expectNothingHoldsTheDirectory(join(root, 'journal-b'))
  })
})
