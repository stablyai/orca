import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import * as boundedFiles from '../../../shared/node-bounded-file-reader'
import {
  AgentSessionRecoveryCapsule,
  AGENT_SESSION_RECOVERY_CAPSULE_FILE
} from '../../runtime/agent-session-recovery-capsule'
import { journalDatabasePath } from '../agent-session-journal/journal-host-database'
import {
  liveTestJournalRows,
  openTestJournalHostDatabase
} from '../agent-session-journal/journal-host-database-test-support'
import {
  attach,
  CALLER,
  envelope,
  hostTestRecoveryCapsuleSettled,
  hostTestState
} from './structured-agent-session-host-test-harness'
import {
  HOST_TEST_NOW,
  HOST_TEST_SESSION,
  HOST_TEST_THREAD,
  hostTestMessage
} from './structured-agent-session-host-test-data'
import { marker } from './structured-agent-session-restart-resume-test-harness'

afterEach(() => vi.restoreAllMocks())

it('releases the attach recovery lock without losing journal or recovery evidence on corruption', async () => {
  const { root, host, acquire, dispatch, cancelTurn } = hostTestState()
  const capsule = new AgentSessionRecoveryCapsule(root)
  const offer = marker({ sessionId: 'other-chat' })
  await capsule.record([offer], HOST_TEST_NOW)
  const capsulePath = join(root, AGENT_SESSION_RECOVERY_CAPSULE_FILE)
  const lockName = `${AGENT_SESSION_RECOVERY_CAPSULE_FILE}.lock`
  const entered = Promise.withResolvers<void>()
  const released = Promise.withResolvers<void>()
  const read = boundedFiles.readNodeFileWithinLimit
  // Hold the real capsule read after proper-lockfile acquired its directory, without replacing it.
  const reader = vi
    .spyOn(boundedFiles, 'readNodeFileWithinLimit')
    .mockImplementation(async (...args) => {
      if (args[0] === capsulePath) {
        entered.resolve()
        await released.promise
      }
      return read(...args)
    })
  try {
    await attach()
    await entered.promise
    const events = acquire.mock.calls.at(-1)?.[0].events
    if (!events) {
      throw new Error('Expected the attached provider event sink')
    }
    events.appendItem(
      { provider: 'codex', threadId: HOST_TEST_THREAD, turnId: 'turn-1', ordinal: 900 },
      {
        kind: 'message',
        role: 'assistant',
        blocks: [{ type: 'text', text: 'retained before damage' }]
      },
      { turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
    events.appendItem(
      { provider: 'codex', threadId: HOST_TEST_THREAD, turnId: 'turn-1', ordinal: 901 },
      { kind: 'turn', turnId: 'turn-1', state: 'running' },
      { turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
    await host.flushStreamedEvents(HOST_TEST_SESSION)
    const duringWithdrawal = (await readdir(root, { recursive: true })).sort()
    expect(duringWithdrawal).toContain(lockName)

    released.resolve()
    await hostTestRecoveryCapsuleSettled()
    reader.mockRestore()
    const files = (await readdir(root, { recursive: true })).sort()
    expect(files).not.toContain(lockName)
    expect(duringWithdrawal).toEqual([...files, lockName].sort())
    expect(await capsule.list(HOST_TEST_NOW)).toEqual([offer])

    const database = openTestJournalHostDatabase(root)
    const rows = liveTestJournalRows(database.db, HOST_TEST_SESSION)
    expect(rows.length).toBeGreaterThan(0)
    expect(JSON.stringify(rows)).toContain('retained before damage')
    const records = database.db
      .prepare('SELECT * FROM agent_session_records ORDER BY session_id')
      .all()
    expect(records.length).toBeGreaterThan(0)
    const retainedPaths = [
      journalDatabasePath(root),
      `${journalDatabasePath(root)}-wal`,
      capsulePath
    ]
    const bytes = await Promise.all(retainedPaths.map((file) => readFile(file)))
    const damaged = Object.assign(new Error('database disk image is malformed'), {
      code: 'ERR_SQLITE_ERROR',
      errcode: 11
    })
    vi.spyOn(database, 'transaction').mockImplementation(() => {
      throw damaged
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const rejectedBody = hostTestMessage('refused after damage')
    await expect(
      host.send(CALLER, {
        envelope: envelope('agentSession.send', { body: rejectedBody }),
        body: rejectedBody
      })
    ).resolves.toMatchObject({
      ok: false,
      refusal: {
        code: 'agent_session_journal_unreadable',
        message: 'Unable to load this chat.',
        details: { reason: 'journalCorrupt' }
      }
    })
    await expect(
      host.cancel(CALLER, {
        envelope: envelope('agentSession.cancel', { turnId: 'turn-1' }),
        turnId: 'turn-1'
      })
    ).rejects.toBe(damaged)
    expect(dispatch).not.toHaveBeenCalled()
    expect(cancelTurn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith(
      "[agent-session] stop-ledger-row: writing Stop's ledger row failed; Stop runs without it",
      expect.objectContaining({ scope: 'stop-ledger-row', error: damaged })
    )
    await hostTestRecoveryCapsuleSettled()
    expect((await readdir(root, { recursive: true })).sort()).toEqual(files)
    expect(await Promise.all(retainedPaths.map((file) => readFile(file)))).toEqual(bytes)
    expect(liveTestJournalRows(database.db, HOST_TEST_SESSION)).toEqual(rows)
    expect(
      database.db.prepare('SELECT * FROM agent_session_records ORDER BY session_id').all()
    ).toEqual(records)
    expect(await capsule.list(HOST_TEST_NOW)).toEqual([offer])
  } finally {
    released.resolve()
    await hostTestRecoveryCapsuleSettled()
    reader.mockRestore()
  }
})
