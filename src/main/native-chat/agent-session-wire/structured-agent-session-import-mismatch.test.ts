// A chat whose per-chat file did not read back as its copy is refused as history that cannot be
// loaded: on a send and a Stop as on a read. Each retry runs the same copy, so "try again" is wrong.

import { cp, rm } from 'node:fs/promises'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { openTestAgentSessionRecordStore } from '../../runtime/agent-session-record-store-test-harness'
import { openTestJournalHostDatabase } from '../agent-session-journal/journal-host-database-test-support'
import {
  JournalImportMismatchError,
  journalOpenRefusalError
} from '../agent-session-journal/journal-open-failure'
import { replayJournal } from '../agent-session-journal/journal-open'
import type * as PerSessionImport from '../agent-session-journal/journal-per-session-import'
import { StructuredAgentSessionHost } from './structured-agent-session-host'
import {
  adapter,
  attach,
  CALLER,
  envelope,
  hostTestState,
  replaceHostTestState
} from './structured-agent-session-host-test-harness'
import {
  HOST_TEST_NOW as NOW,
  HOST_TEST_SESSION as SESSION,
  hostTestMessage
} from './structured-agent-session-host-test-data'
import { createStructuredAgentSessionLogger } from './structured-agent-session-logger'

const { copy } = vi.hoisted(() => ({ copy: { mismatched: false } }))

vi.mock('../agent-session-journal/journal-per-session-import', async (importOriginal) => {
  const actual = await importOriginal<typeof PerSessionImport>()
  return {
    ...actual,
    // What the copy's verify throws for a file that does not read back as copied.
    importPerSessionJournal: async (
      input: Parameters<typeof actual.importPerSessionJournal>[0]
    ) => {
      if (!copy.mismatched) {
        return actual.importPerSessionJournal(input)
      }
      throw journalOpenRefusalError(
        new JournalImportMismatchError(
          `per-chat journal of ${input.identity.sessionId} read back short`
        )
      )
    },
    // Restore lists a chat still in its per-chat file from a fold of it, and owes the copy.
    previewPerSessionJournal: async (
      input: Parameters<typeof actual.previewPerSessionJournal>[0]
    ) =>
      copy.mismatched
        ? replayJournal(input.database.db, input.identity.sessionId)
        : actual.previewPerSessionJournal(input)
  }
})

const UNLOADABLE = {
  ok: false,
  refusal: {
    code: 'agent_session_journal_unreadable',
    message: 'Unable to load this chat.',
    details: { reason: 'journalCorrupt' }
  }
}

const relaunchedRoots: string[] = []

beforeEach(() => {
  copy.mismatched = false
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
})

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(
    relaunchedRoots.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))
  )
})

/** A restarted process over the chat's files, holding no chat open; its copy now mismatches. */
async function relaunchWithMismatchedCopy(): Promise<StructuredAgentSessionHost> {
  const before = hostTestState()
  await attach()
  await before.host.flushStreamedEvents(SESSION)
  await before.store.renewLeases([])
  const relaunched = `${before.root}-relaunched`
  relaunchedRoots.push(relaunched)
  // A dead process holds no lock.
  await cp(before.root, relaunched, {
    recursive: true,
    filter: (source) => !source.includes('.lock')
  })
  const store = await openTestAgentSessionRecordStore(relaunched)
  const host = new StructuredAgentSessionHost({
    logger: createStructuredAgentSessionLogger(),
    store,
    adapter: adapter(),
    journalDatabase: openTestJournalHostDatabase(relaunched),
    claimKeyId: 'key-1',
    mintSpawnToken: () => 'spawn-next',
    now: () => NOW
  })
  replaceHostTestState({ store, host })
  copy.mismatched = true
  return host
}

function send(host: StructuredAgentSessionHost) {
  const body = hostTestMessage('sent to a chat that did not copy')
  return host.send(CALLER, { envelope: envelope('agentSession.send', { body }), body })
}

it('refuses a send and a Stop that open the chat as unloadable', async () => {
  const host = await relaunchWithMismatchedCopy()

  await expect(send(host)).resolves.toMatchObject(UNLOADABLE)
  await expect(
    host.cancel(CALLER, {
      envelope: envelope('agentSession.cancel', { turnId: 'turn-1' }),
      turnId: 'turn-1'
    })
  ).resolves.toMatchObject(UNLOADABLE)
  await host.flushAllStreamedEvents()
})

// Startup listed the chat from its per-chat file; the send's write pays the copy it owes.
it('refuses a send to a restored chat as unloadable when the copy it owes does not verify', async () => {
  const host = await relaunchWithMismatchedCopy()
  await host.restoreReadableSessions([SESSION])
  expect(host.hasSession(SESSION)).toBe(true)

  await expect(send(host)).resolves.toMatchObject(UNLOADABLE)
  await host.flushAllStreamedEvents()
})
