import { JournalLegacyRetentionError } from './journal-legacy-retention-error'
import {
  existsSync,
  writeFileSync,
  readFileSync,
  statSync,
  readdirSync,
  unlinkSync,
  statfsSync
} from 'node:fs'
import { join, basename } from 'node:path'
import { ChildProcess } from 'node:child_process'
import { PassThrough } from 'node:stream'
import { spawnProcess } from '@orca/process-host'
import { expect, it, vi } from 'vitest'
import Database from '../../sqlite/sync-database'
import { journalLegacyFileIdentity } from './database/journal-legacy-source-receipt'
import { JournalSqlDatabase } from './database/journal-sql-database'
import {
  journalSqlWorkerPath,
  journalSqlReaderPath
} from './journal-sql-worker-bundle.test-fixture'
import { message } from './journal-sql-message.test-fixture'
import { createJournalLegacyFileEligibility } from './journal-legacy-file-lock'
import {
  advanceLegacyRetirementClock,
  JournalLegacyGraceClock
} from './journal-legacy-retirement-state'
import { journalSqlRetryRows } from './journal-sql-retry-rows.test-fixture'
import { insertJournalRow } from './durable-rows/journal-row-table'
import { profile, cleanup } from './journal-legacy-retirement.test-fixture'

vi.mock('@orca/process-host', { spy: true })

it('accounts for an unopened folder chat, removes only the certified file and keeps current history', async () => {
  const test = await profile((legacy) => {
    legacy.exec(`INSERT INTO journal_outcome_generations VALUES(900,'unopened','retired-epoch');
      INSERT INTO journal_outcomes VALUES(900,1,'retired','key',1,'0','"unreachable retired text"',0)`)
    legacy
      .prepare(
        `INSERT INTO queued_messages(session_id,message_id,position,body_json,fingerprint,created_at,host_instance,state,hold_reason,queued_epoch,queued_sequence)
         VALUES('unopened','saved-card',1,?,'f',1,'h','waiting','manual','epoch',1)`
      )
      .run(
        JSON.stringify({
          kind: 'message',
          role: 'user',
          blocks: [{ type: 'text', text: 'saved queued text survives retirement' }]
        })
      )
  })
  const allocated = () => ({
    files: Object.fromEntries(
      readdirSync(test.root).map((name) => {
        const file = statSync(join(test.root, name))
        return [name, { logical: Number(file.size), allocated: Number(file.blocks) * 512 }]
      })
    ),
    freeBytes: Number(statfsSync(test.root).bfree) * Number(statfsSync(test.root).bsize)
  })
  const before = allocated()
  const proofStart = performance.now()
  await test.retirement.run()
  expect(test.errors).toEqual([])
  expect(existsSync(test.filename)).toBe(true)
  const proofMs = performance.now() - proofStart
  const proof = test.receiptState()
  test.saveState({ ...proof, credit: 604800000 })
  await test.retirement.run()
  expect(existsSync(test.filename)).toBe(true)
  test.arm()
  const deletionStart = performance.now()
  await test.retirement.run()
  expect(test.errors).toEqual([])
  expect(existsSync(test.filename)).toBe(false)
  expect(
    test.db
      .prepare(
        "SELECT payload_json FROM journal_items WHERE session_id='unopened' AND payload_json LIKE '%compact%' LIMIT 1"
      )
      .get()
  ).toBeDefined()
  expect(
    test.db
      .prepare(
        "SELECT payload_json FROM journal_queue_cards WHERE session_id='unopened' AND message_id='saved-card'"
      )
      .get()!.payload_json
  ).toContain('saved queued text survives retirement')
  await test.retirement.run()
  expect(existsSync(test.filename)).toBe(false)
  test.db.pragma('wal_checkpoint(TRUNCATE)')
  test.closeDomain()
  const after = allocated()
  const total = (files: typeof before.files) =>
    Object.values(files).reduce((sum, value) => sum + value.allocated, 0)
  console.info('synthetic allocated bytes after checkpoint and handle closure', {
    before,
    after,
    grossLegacyRemoved: before.files[basename(test.filename)]!.allocated,
    netRemoved: total(before.files) - total(after.files),
    proofMs,
    retireAndCheckpointMs: performance.now() - deletionStart
  })
  const options = {
    writerPath: journalSqlWorkerPath(),
    readerPath: journalSqlReaderPath(),
    onMaintenanceError: () => {}
  }
  const current = await JournalSqlDatabase.open(test.root, options)
  try {
    const { target } = await current.openSession({
      sessionId: 'new-current-chat',
      workspaceId: 'folder-without-git',
      hostId: 'synthetic-host',
      agent: 'codex',
      providerHandle: null
    })
    const step = message('saved after legacy retirement')
    await current.write({
      target,
      savedAt: 100,
      operation: {
        kind: 'steps',
        steps: [
          {
            kind: 'resolved-item',
            reservedBytes: 1024,
            resolution: { kind: 'text-snapshot', identity: step.identity, body: step.body },
            options: step.options
          }
        ]
      }
    })
  } finally {
    await current.close()
  }
  const reopened = await JournalSqlDatabase.open(test.root, options)
  try {
    expect(
      await reopened.readers.domainHistory({
        sessionId: 'new-current-chat',
        direction: 'after',
        limit: 10
      })
    ).toMatchObject({
      page: { items: [{ body: { blocks: [{ text: 'saved after legacy retirement' }] } }] }
    })
    expect(existsSync(test.filename)).toBe(false)
  } finally {
    await reopened.close()
  }
})

it('retains downgrade writes, a rollback journal and a nonempty WAL without changing their bytes', async () => {
  for (const kind of ['append', 'journal', 'wal'] as const) {
    const test = await profile()
    await test.retirement.run()
    test.arm()
    if (kind === 'append') {
      const old = new Database(test.filename)
      old
        .prepare('INSERT INTO journal_sessions VALUES(?,?,?)')
        .run('old-new-chat', 'folder', 'new-epoch')
      const savedItem = journalSqlRetryRows(true).find((row) => row.kind === 'item')!
      insertJournalRow(old, 'unopened', {
        ...savedItem,
        seq: journalSqlRetryRows(true).length + 1,
        itemId: 'downgraded-text',
        body: {
          kind: 'message',
          role: 'user',
          blocks: [{ type: 'text', text: 'saved by the downgraded build' }]
        }
      })
      insertJournalRow(old, 'old-new-chat', {
        ...journalSqlRetryRows(true)[0]!,
        epoch: 'new-epoch',
        seq: 1
      })
      old.close()
    } else {
      writeFileSync(test.filename + (kind === 'wal' ? '-wal' : '-journal'), 'owed recovery bytes')
    }
    const before = readFileSync(test.filename)
    await test.retirement.run()
    expect(existsSync(test.filename)).toBe(true)
    expect(readFileSync(test.filename)).toEqual(before)
    if (kind === 'append') {
      expect(
        test
          .source()
          .prepare("SELECT session_id FROM journal_sessions WHERE session_id='old-new-chat'")
          .get()
      ).toBeDefined()
      expect(
        test
          .source()
          .prepare(
            "SELECT row_json FROM journal_rows WHERE session_id='unopened' ORDER BY seq DESC LIMIT 1"
          )
          .get()!.row_json
      ).toContain('saved by the downgraded build')
    } else {
      expect(readFileSync(test.filename + (kind === 'wal' ? '-wal' : '-journal'), 'utf8')).toBe(
        'owed recovery bytes'
      )
      if (kind === 'journal') {
        unlinkSync(`${test.filename}-journal`)
        const now = performance.now()
        const clock = vi.spyOn(performance, 'now').mockReturnValue(now + 3600001)
        await test.retirement.run()
        expect(existsSync(test.filename)).toBe(false)
        clock.mockRestore()
      }
    }
  }
})

it('does not earn grace from forward wall-clock steps and re-stamps a future completion', () => {
  const state = {
    version: 1 as const,
    proof: 'proof',
    proofId: 'id',
    completedAt: 100,
    process: 'prior',
    credit: 0,
    creditRevision: 0,
    lastWall: 100,
    phase: 'grace' as const
  }
  expect(advanceLegacyRetirementClock(state, 691200100, 3600000, 'next').credit).toBe(3600000)
  expect(
    advanceLegacyRetirementClock(
      { ...state, completedAt: 9000, credit: 604800000 },
      1000,
      10,
      'next'
    )
  ).toMatchObject({ completedAt: 1000, credit: 0, process: 'next' })

  let mono = 0n
  vi.spyOn(process.hrtime, 'bigint').mockImplementation(() => mono)
  const clock = new JournalLegacyGraceClock()
  clock.persisted(state)
  mono = 3600000000000n
  expect(clock.observe(state, 691200100, 'next').credit).toBe(3600000)
  clock.pause()
  expect(clock.observe(state, 691200100, 'next').credit).toBe(3600000)
  const ambiguousCommit = { ...state, credit: 3600000, creditRevision: 1 }
  mono = 7200000000000n
  expect(clock.observe(ambiguousCommit, 691200100, 'next').credit).toBe(3600000)
})

it('retains queued-only text, recovery obligations and orphan history', async () => {
  for (const kind of [
    'queue',
    'repair',
    'orphan',
    'orphan-outcome',
    'extra-profile-column',
    'malformed-queue'
  ] as const) {
    const test = await profile((legacy) => {
      if (kind === 'queue') {
        legacy.exec(
          'DELETE FROM journal_rows; INSERT INTO queued_messages(session_id,message_id,position,body_json,fingerprint,created_at,host_instance,state,hold_reason) VALUES(\'unopened\',\'held\',1,\'{"kind":"message","role":"user","blocks":[{"type":"text","text":"held user text"}]}\',\'f\',1,\'h\',\'waiting\',\'manual\')'
        )
      } else if (kind === 'malformed-queue') {
        legacy.exec(
          "INSERT INTO queued_messages(session_id,message_id,position,body_json,fingerprint,created_at,host_instance,state,hold_reason) VALUES('unopened','held',1,'unreadable saved text','f',1,'h','waiting','manual')"
        )
      } else if (kind === 'orphan-outcome') {
        legacy.exec(
          `INSERT INTO journal_outcomes VALUES(901,1,'orphan','key',1,'0','"orphan user text"',0)`
        )
      } else if (kind === 'repair') {
        legacy.exec("INSERT INTO journal_repairs VALUES('unopened','epoch',1,100)")
      } else if (kind === 'extra-profile-column') {
        legacy.exec(
          "ALTER TABLE agent_session_records ADD COLUMN future_text TEXT; INSERT INTO agent_session_records VALUES('unopened','{}','saved future field')"
        )
      } else {
        legacy.exec("INSERT INTO journal_rows VALUES('orphan','old',1,1,'orphan user text')")
      }
    })
    if (kind === 'malformed-queue') {
      test.db
        .prepare(
          "UPDATE journal_chat_state SET epoch='epoch',last_sequence=1,highest_fence=0 WHERE session_id='unopened'"
        )
        .run()
    }
    if (kind === 'queue') {
      const current = await JournalSqlDatabase.open(test.root, {
        writerPath: journalSqlWorkerPath(),
        readerPath: journalSqlReaderPath(),
        onMaintenanceError: () => {}
      })
      try {
        await current.openSession({
          sessionId: 'unopened',
          workspaceId: 'folder-without-git',
          hostId: 'synthetic-host',
          agent: 'codex',
          providerHandle: null
        })
      } finally {
        await current.close()
      }
    }
    const before = readFileSync(test.filename)
    await test.retirement.run()
    expect(test.errors.length).toBeGreaterThan(0)
    if (kind === 'malformed-queue') {
      expect(test.receiptState()).toMatchObject({ phase: 'refused', reason: 'source-queue' })
    }
    expect(readFileSync(test.filename)).toEqual(before)
    if (kind === 'queue') {
      expect(test.source().prepare('SELECT body_json FROM queued_messages').get()).toEqual({
        body_json:
          '{"kind":"message","role":"user","blocks":[{"type":"text","text":"held user text"}]}'
      })
    }
  }
})

it('resumes only the prepared empty companions and preserves a recreated main', async () => {
  for (const recreate of [false, true]) {
    const test = await profile()
    await test.retirement.run()
    await test.recycle()
    const shm = `${test.filename}-shm`
    writeFileSync(shm, 'derived index')
    const state = {
      ...test.receiptState(),
      phase: 'prepared',
      manifest: {
        '-shm': journalLegacyFileIdentity(shm),
        ...(existsSync(`${test.filename}-wal`)
          ? { '-wal': journalLegacyFileIdentity(`${test.filename}-wal`) }
          : {})
      }
    }
    test.saveState(state)
    unlinkSync(test.filename)
    if (recreate) {
      writeFileSync(test.filename, 'new old-build history')
    }
    await test.retirement.run()
    if (recreate) {
      expect(readFileSync(shm, 'utf8')).toBe('derived index')
    }
    if (recreate) {
      expect(readFileSync(test.filename, 'utf8')).toBe('new old-build history')
    } else {
      expect(test.errors).toEqual([])
      expect(existsSync(shm)).toBe(false)
    }
  }
})

it('retires in the same owner after a missing helper is restored', async () => {
  let available = false
  let now = 0
  vi.spyOn(performance, 'now').mockImplementation(() => now)
  const test = await profile(undefined, {
    check: async () => {},
    present: () => {
      if (!available) {
        throw new JournalLegacyRetentionError('legacy journal lock asset is unavailable')
      }
    }
  })
  await test.retirement.run()
  expect(test.errors).toHaveLength(1)
  expect(existsSync(test.filename)).toBe(true)
  available = true
  now = 60_001
  await test.retirement.run()
  expect(test.receiptState().phase).toBe('grace')
  test.arm()
  await test.retirement.run()
  expect(test.errors).toHaveLength(1)
  expect(existsSync(test.filename)).toBe(false)
})

it('keeps eligibility pending until a termination-resistant check exits, then retires', async () => {
  let now = 0
  vi.spyOn(performance, 'now').mockImplementation(() => now)
  const test = await profile(undefined, {
    ...createJournalLegacyFileEligibility(),
    present: () => {}
  })
  const proof = vi.spyOn(test.readers, 'legacyProof')
  const recycle = vi.spyOn(test.readers, 'recycleSourceReaders')
  const child = () => {
    const helper = Object.assign(new ChildProcess(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(() => false)
    })
    cleanup.push(() => {
      helper.emit('exit', null, 'SIGKILL')
      helper.stdin.destroy()
      helper.stdout.destroy()
      helper.stderr.destroy()
    })
    return helper
  }
  const stuck = child()
  const started = Promise.withResolvers<void>()
  const spawn = vi.mocked(spawnProcess).mockClear()
  spawn.mockImplementationOnce(() => {
    started.resolve()
    return stuck
  })
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const attempt = test.retirement.run()
  await started.promise
  await vi.advanceTimersByTimeAsync(5_250)
  await attempt
  vi.useRealTimers()
  expect(stuck.kill).toHaveBeenCalledWith('SIGKILL')
  for (now of [60_001, 180_002, 420_003]) {
    await test.retirement.run()
    expect(test.errors.at(-1)).toMatchObject({ message: 'legacy journal eligibility pending' })
  }
  expect(spawn).toHaveBeenCalledOnce()
  expect(proof).not.toHaveBeenCalled()
  expect(recycle).not.toHaveBeenCalled()
  expect(existsSync(test.filename)).toBe(true)

  stuck.emit('exit', null, 'SIGKILL')
  const recovered = child()
  spawn.mockImplementationOnce(() => {
    queueMicrotask(() => {
      recovered.stdout.write('eligible\n')
      recovered.emit('exit', 0)
    })
    return recovered
  })
  now = 900_004
  await test.retirement.run()
  expect(test.receiptState().phase).toBe('grace')
  test.arm()
  await test.retirement.run()
  expect(test.errors).toHaveLength(2)
  expect(existsSync(test.filename)).toBe(false)
})
