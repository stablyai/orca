import { readdir } from 'node:fs/promises'
import { afterEach, beforeEach, expect, it, vi, type Mock } from 'vitest'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import { openTestJournalHostDatabase } from '../agent-session-journal/journal-host-database-test-support'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import type { StructuredAgentSessionHost } from './structured-agent-session-host'
import {
  attach,
  CALLER,
  envelope,
  hostTestRecoveryCapsuleSettled,
  hostTestState
} from './structured-agent-session-host-test-harness'
import {
  HOST_TEST_SESSION,
  HOST_TEST_THREAD,
  hostTestMessage
} from './structured-agent-session-host-test-data'

let root: string
let store: AgentSessionRecordStore
let host: StructuredAgentSessionHost
let cancelTurn: Mock<StructuredAgentSessionAdapter['cancelTurn']>
let acquire: Mock<StructuredAgentSessionAdapter['acquire']>

beforeEach(() => {
  ;({ root, store, host, cancelTurn, acquire } = hostTestState())
})

async function runningTurn(): Promise<void> {
  await attach()
  acquire.mock.calls
    .at(-1)![0]
    .events!.appendItem(
      { provider: 'codex', threadId: HOST_TEST_THREAD, turnId: 'turn-1', ordinal: 900 },
      { kind: 'turn', turnId: 'turn-1', state: 'running' },
      { turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
  await host.flushStreamedEvents(HOST_TEST_SESSION)
}

afterEach(() => vi.restoreAllMocks())

const sqliteError = (message: string, errcode: number): Error =>
  Object.assign(new Error(message), { code: 'ERR_SQLITE_ERROR', errcode })

/** Fail chat-record statements while leaving history readable. */
function failRecordStatements(error: Error): void {
  const connection = openTestJournalHostDatabase(root).db
  const prepare = connection.prepare.bind(connection)
  vi.spyOn(connection, 'prepare').mockImplementation((sql: string) => {
    if (sql.includes('agent_session_')) {
      throw error
    }
    return prepare(sql)
  })
}

const stop = (turnEnvelope = envelope('agentSession.cancel', { turnId: 'turn-1' })) =>
  host.cancel(CALLER, { envelope: turnEnvelope, turnId: 'turn-1' })

it('refuses a send and a Stop as corrupt when SQLite reports damage, interrupting nothing', async () => {
  await runningTurn()
  // Drain restart-offer withdrawal before snapshotting its lock files.
  await hostTestRecoveryCapsuleSettled()
  const files = (await readdir(root, { recursive: true })).toSorted()
  const damaged = sqliteError('database disk image is malformed', 11)
  vi.spyOn(openTestJournalHostDatabase(root), 'transaction').mockImplementation(() => {
    throw damaged
  })
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)

  const body = hostTestMessage('after the damage')
  const sent = await host.send(CALLER, { envelope: envelope('agentSession.send', { body }), body })

  expect(sent).toMatchObject({
    ok: false,
    refusal: {
      code: 'agent_session_journal_unreadable',
      message: 'Unable to load this chat.',
      details: { reason: 'journalCorrupt' }
    }
  })
  expect(await stop()).toMatchObject({
    ok: false,
    refusal: { code: 'agent_session_journal_unreadable', details: { reason: 'journalCorrupt' } }
  })
  expect(cancelTurn).not.toHaveBeenCalled()
  await hostTestRecoveryCapsuleSettled()
  expect((await readdir(root, { recursive: true })).toSorted()).toEqual(files)
})

it.each([
  ['damaged', sqliteError('database disk image is malformed', 11)],
  ['full', sqliteError('database or disk is full', 13)]
])('answers unknown and interrupts nothing when the records are %s', async (_, error) => {
  await runningTurn()
  failRecordStatements(error)
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)

  // Unreadable receipts leave prior acceptance unknown.
  await expect(stop()).resolves.toMatchObject({
    ok: false,
    refusal: { code: 'agent_session_operation_unknown' }
  })
  expect(cancelTurn).not.toHaveBeenCalled()
})

it('replays a recorded Stop from its receipt when its ledger cannot be written', async () => {
  await runningTurn()
  const stopEnvelope = envelope('agentSession.cancel', { turnId: 'turn-1' })
  await expect(stop(stopEnvelope)).resolves.toMatchObject({ ok: true, replayed: false })
  expect(cancelTurn).toHaveBeenCalledTimes(1)
  // Even receipt replay requires the store transaction to succeed.
  vi.spyOn(store, 'admitMutationOperation').mockRejectedValue(
    sqliteError('database disk image is malformed', 11)
  )
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)

  // A repeated interrupt could stop a turn this request never targeted.
  await expect(stop(stopEnvelope)).resolves.toMatchObject({
    ok: true,
    replayed: true,
    value: { turnId: 'turn-1', cancelled: false }
  })
  expect(cancelTurn).toHaveBeenCalledTimes(1)
})
