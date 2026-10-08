// Receipts are read from SQLite, so a read can fail where a write can: Stop still reaches the agent,
// and a send refuses rather than run without the row that dedupes it.

import { afterEach, beforeEach, expect, it, vi, type Mock } from 'vitest'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import { openTestJournalHostDatabase } from '../agent-session-journal/journal-host-database-test-support'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import type { StructuredAgentSessionHost } from './structured-agent-session-host'
import {
  attach,
  CALLER,
  envelope,
  hostTestState
} from './structured-agent-session-host-test-harness'
import {
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_THREAD as THREAD,
  hostTestMessage
} from './structured-agent-session-host-test-data'

let root: string
let host: StructuredAgentSessionHost
let acquire: Mock<StructuredAgentSessionAdapter['acquire']>
let cancelTurn: Mock<StructuredAgentSessionAdapter['cancelTurn']>
let dispatch: Mock<StructuredAgentSessionAdapter['dispatch']>

beforeEach(() => {
  ;({ root, host, acquire, cancelTurn, dispatch } = hostTestState())
})

afterEach(() => vi.restoreAllMocks())

const damaged = Object.assign(new Error('database disk image is malformed'), {
  code: 'ERR_SQLITE_ERROR',
  errcode: 11
})

/** Every read of the operation receipts fails; the records and history beside them still work. */
function failReceiptReads(): void {
  const connection = openTestJournalHostDatabase(root).db
  const prepare = connection.prepare.bind(connection)
  vi.spyOn(connection, 'prepare').mockImplementation((sql: string) => {
    if (sql.includes('agent_session_operations')) {
      throw damaged
    }
    return prepare(sql)
  })
}

/** The provider's record of a running turn, as its translator writes it. */
async function runningTurn(): Promise<void> {
  const events = acquire.mock.calls.at(-1)?.[0].events
  if (!events) {
    throw new Error('a running turn requires an acquired session')
  }
  events.appendItem(
    { provider: 'codex', threadId: THREAD, turnId: 'turn-1', ordinal: 900 },
    { kind: 'turn', turnId: 'turn-1', state: 'running' },
    { turnScope: AGENT_JOURNAL_THREAD_SCOPE }
  )
  await host.flushStreamedEvents(SESSION)
}

it('stops the agent from the Stop button when no receipt can be read', async () => {
  await attach()
  await runningTurn()
  failReceiptReads()
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

  await expect(
    host.cancel(CALLER, { envelope: envelope('agentSession.cancel', {}) })
  ).resolves.toMatchObject({ ok: true, replayed: false, value: { cancelled: true } })
  expect(cancelTurn).toHaveBeenCalledTimes(1)
  expect(warn).toHaveBeenCalledWith(
    "[agent-session] stop-ledger-row: reading Stop's ledger row failed; Stop runs as if none were recorded",
    expect.objectContaining({ scope: 'stop-ledger-row', error: damaged })
  )
})

it('refuses a send as an unreadable chat when its receipt cannot be read', async () => {
  await attach()
  dispatch.mockClear()
  failReceiptReads()

  const body = hostTestMessage('after the damage')
  await expect(
    host.send(CALLER, { envelope: envelope('agentSession.send', { body }), body })
  ).resolves.toMatchObject({
    ok: false,
    refusal: { code: 'agent_session_journal_unreadable', details: { reason: 'journalCorrupt' } }
  })
  expect(dispatch).not.toHaveBeenCalled()
})
