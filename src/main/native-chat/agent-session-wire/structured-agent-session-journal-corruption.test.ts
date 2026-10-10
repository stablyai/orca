// Damage SQLite reports in the middle of a session: the write that meets it fails and says the
// chat cannot be loaded, the agent can still be stopped, and nothing is renamed or rebuilt.

import { readdir } from 'node:fs/promises'
import { afterEach, beforeEach, expect, it, vi, type Mock } from 'vitest'
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
import { hostTestMessage } from './structured-agent-session-host-test-data'

const STOP_LEDGER_ROW_FAILED =
  "[agent-session] stop-ledger-row: writing Stop's ledger row failed; Stop runs without it"

let root: string
let store: AgentSessionRecordStore
let host: StructuredAgentSessionHost
let cancelTurn: Mock<StructuredAgentSessionAdapter['cancelTurn']>

beforeEach(() => {
  ;({ root, store, host, cancelTurn } = hostTestState())
})

afterEach(() => vi.restoreAllMocks())

const sqliteError = (message: string, errcode: number): Error =>
  Object.assign(new Error(message), { code: 'ERR_SQLITE_ERROR', errcode })

/** Every statement on the chat records' tables fails; the history beside them still works. */
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

// T-corrupt-midsession.
it('refuses a send as corrupt when SQLite reports damage, and still stops the agent', async () => {
  await attach()
  // The attach's restart-offer withdrawal holds a lock file until it ends; snapshot after it.
  await hostTestRecoveryCapsuleSettled()
  // Order-free: recursive listing order is the runtime's, and only what exists matters.
  const files = (await readdir(root, { recursive: true })).toSorted()
  const damaged = sqliteError('database disk image is malformed', 11)
  vi.spyOn(openTestJournalHostDatabase(root), 'transaction').mockImplementation(() => {
    throw damaged
  })
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

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
  // Stop reaches the agent without its ledger row; the note it then cannot record is the error
  // the caller sees, after the fact.
  await expect(stop()).rejects.toBe(damaged)
  expect(cancelTurn).toHaveBeenCalledTimes(1)
  expect(warn).toHaveBeenCalledWith(STOP_LEDGER_ROW_FAILED, {
    scope: 'stop-ledger-row',
    sessionId: expect.any(String),
    error: expect.objectContaining({ message: 'database disk image is malformed' })
  })
  await hostTestRecoveryCapsuleSettled()
  expect((await readdir(root, { recursive: true })).toSorted()).toEqual(files)
})

it.each([
  ['damaged', sqliteError('database disk image is malformed', 11)],
  ['full', sqliteError('database or disk is full', 13)]
])('stops the agent when the records are %s and the history is not', async (_, error) => {
  await attach()
  failRecordStatements(error)
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

  await expect(stop()).resolves.toMatchObject({
    ok: true,
    replayed: false,
    value: { turnId: 'turn-1', cancelled: true }
  })
  expect(cancelTurn).toHaveBeenCalledTimes(1)
  expect(warn).toHaveBeenCalledWith(STOP_LEDGER_ROW_FAILED, {
    scope: 'stop-ledger-row',
    sessionId: expect.any(String),
    error
  })
})

it('replays a recorded Stop from memory when its ledger cannot be written', async () => {
  await attach()
  const stopEnvelope = envelope('agentSession.cancel', { turnId: 'turn-1' })
  await expect(stop(stopEnvelope)).resolves.toMatchObject({ ok: true, replayed: false })
  expect(cancelTurn).toHaveBeenCalledTimes(1)
  // A replay writes nothing on a healthy store; one that refuses every transaction still throws.
  vi.spyOn(store, 'admitMutationOperation').mockRejectedValue(
    sqliteError('database disk image is malformed', 11)
  )
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)

  // Interrupting twice would stop a turn the client never asked to stop.
  await expect(stop(stopEnvelope)).resolves.toMatchObject({
    ok: true,
    replayed: true,
    value: { turnId: 'turn-1', cancelled: false }
  })
  expect(cancelTurn).toHaveBeenCalledTimes(1)
})
