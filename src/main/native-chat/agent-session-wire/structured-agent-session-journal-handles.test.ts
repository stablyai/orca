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
import {
  evictStructuredAgentSession,
  STRUCTURED_AGENT_SESSION_EVICTION_STEPS,
  type StructuredAgentSessionEvictionContext
} from './structured-agent-session-eviction'
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
    fence: 1,
    hasProviderChild: false,
    acquisitionGeneration: null
  }
}

function evictionContext(
  overrides: Partial<StructuredAgentSessionEvictionContext>
): StructuredAgentSessionEvictionContext {
  return {
    sessionId: SESSION,
    hasProviderChild: false,
    eventSink: {
      drained: async () => ({ ok: true }) as const,
      unbind: () => undefined,
      close: () => undefined
    } as unknown as StructuredAgentSessionEvictionContext['eventSink'],
    adapter: {} as StructuredAgentSessionEvictionContext['adapter'],
    forget: async () => undefined,
    discardSink: () => undefined,
    releaseLease: async () => undefined,
    ...overrides
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

describe('sites 9 and 10: the delete and overwrite callbacks', () => {
  it('awaits the journal close before dropping the map entry', async () => {
    const journal = await journals.open({ identity: IDENTITY, journalDir })
    const sessions = new Map([[SESSION, hostSession(journal)]])
    const order: string[] = []

    await evictStructuredAgentSession(
      evictionContext({
        forget: async () => {
          order.push('close-started')
          await sessions.get(SESSION)?.journal.close()
          order.push('closed')
          sessions.delete(SESSION)
          order.push('forgotten')
        }
      }),
      STRUCTURED_AGENT_SESSION_EVICTION_STEPS
    )

    expect(order).toEqual(['close-started', 'closed', 'forgotten'])
    expect(sessions.size).toBe(0)
    await expectNothingHoldsTheDirectory(journalDir)
  })

  it('aborts the eviction with the session still indexed when the close rejects', async () => {
    const journal = await journals.open({ identity: IDENTITY, journalDir })
    const sessions = new Map([[SESSION, hostSession(journal)]])

    await expect(
      evictStructuredAgentSession(
        evictionContext({
          forget: async () => {
            await Promise.reject(new Error('close rejected'))
          }
        }),
        STRUCTURED_AGENT_SESSION_EVICTION_STEPS
      )
    ).rejects.toMatchObject({ step: 'forget-session' })
    // Still indexed, so the next close is a real retry.
    expect(sessions.has(SESSION)).toBe(true)
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
    await tearDownStructuredAgentSessionHost({ phases: [], sessions })

    expect(sessions.size).toBe(0)
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
    const failing = sessions.get(SESSION)
    const closeError = new Error('close rejected')
    if (failing) {
      failing.journal = {
        close: () => Promise.reject(closeError)
      } as unknown as AgentSessionJournal
    }

    await expect(
      tearDownStructuredAgentSessionHost({ phases: [], sessions })
    ).rejects.toMatchObject({ errors: [closeError] })

    // Only the failure stays indexed — `status === 'fulfilled'`, not "settled".
    expect([...sessions.keys()]).toEqual([SESSION])
    await expectNothingHoldsTheDirectory(join(root, 'journal-b'))
  })
})
