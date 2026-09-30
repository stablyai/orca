// Damage SQLite reports in the middle of a session: the write that meets it fails and says the
// chat cannot be loaded, the agent can still be stopped, and nothing is renamed or rebuilt.

import { readdir } from 'node:fs/promises'
import { afterEach, beforeEach, expect, it, vi, type Mock } from 'vitest'
import { JournalHostDatabase } from '../agent-session-journal/journal-host-database'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import type { StructuredAgentSessionHost } from './structured-agent-session-host'
import {
  attach,
  CALLER,
  envelope,
  hostTestState
} from './structured-agent-session-host-test-harness'
import { hostTestMessage } from './structured-agent-session-host-test-data'

let root: string
let host: StructuredAgentSessionHost
let cancelTurn: Mock<StructuredAgentSessionAdapter['cancelTurn']>

beforeEach(() => {
  ;({ root, host, cancelTurn } = hostTestState())
})

afterEach(() => vi.restoreAllMocks())

// T-corrupt-midsession.
it('refuses a send as corrupt when SQLite reports damage, and still stops the agent', async () => {
  await attach()
  const files = await readdir(root, { recursive: true })
  const damaged = Object.assign(new Error('database disk image is malformed'), {
    code: 'ERR_SQLITE_ERROR',
    errcode: 11
  })
  vi.spyOn(JournalHostDatabase.prototype, 'transaction').mockImplementation(() => {
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
  // Stop reaches the agent before it writes anything; the note it then cannot record is the
  // error the caller sees, after the fact.
  await expect(
    host.cancel(CALLER, {
      envelope: envelope('agentSession.cancel', { turnId: 'turn-1' }),
      turnId: 'turn-1'
    })
  ).rejects.toBe(damaged)
  expect(cancelTurn).toHaveBeenCalledTimes(1)
  expect(await readdir(root, { recursive: true })).toEqual(files)
})
