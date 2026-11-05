import { codexProviderHandle } from '../../../shared/agent-session/lifecycle/agent-session-provider-handle-encoding'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { build } from 'esbuild'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { JournalSqlOwner } from './journal-sql-owner'
import { openJournalDatabase } from './journal-database'
import { JournalNativeService } from './journal-native-service'
import { settleJournalCommitAsync } from './journal-committed-effects'
import { journalSqlFailure, restoreJournalSqlFailure } from './journal-sql-protocol'
import { AgentSessionAttachmentExpiredError } from '../agent-session-attachments/agent-session-attachment-claims'
import { appendJournalUnitPacket, journalUnitPackets } from './journal-unit-transfer'
import type { JournalPersistenceEffect } from './journal-persistence-plan'

let root: string
beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'orca-journal-native-'))
  await build({
    entryPoints: [
      resolve('src/main/native-chat/agent-session-journal/journal-sql-worker-entry.ts')
    ],
    outfile: join(root, 'journal-sql-worker-entry.js'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    logLevel: 'silent'
  })
})
afterAll(() => rmSync(root, { recursive: true, force: true }))

it('owns actual WAL commits off thread and rolls back all effects when a later row fails', async () => {
  const filename = join(root, 'journal.db')
  const fixture = openJournalDatabase(filename)
  fixture.db.exec(
    "CREATE TRIGGER reject_later_row BEFORE INSERT ON journal_rows WHEN NEW.seq = 2 BEGIN SELECT RAISE(ABORT, 'reject later row'); END"
  )
  fixture.db.close()
  const owner = new JournalSqlOwner(filename, {
    workerPath: join(root, 'journal-sql-worker-entry.js')
  })
  try {
    expect(await owner.opened()).toBe(false)
    const commit = async (epoch: string, seq: number) => {
      const effects: JournalPersistenceEffect[] = [
        { kind: 'epoch', sessionId: 'chat', workspaceId: 'folder', epoch },
        { kind: 'rows', sessionId: 'chat', rows: [{ epoch, seq, savedAt: 1, json: '{}' }] }
      ]
      for (const packets of journalUnitPackets(effects)) {
        await owner.request({ type: 'upload', packets: [packets] })
      }
      return owner.request({ type: 'unit', normal: true, count: effects.length })
    }
    expect(await commit('epoch-1', 1)).toMatchObject({ type: 'committed' })
    expect(await owner.connection.prepare('PRAGMA journal_mode').get()).toEqual({
      journal_mode: 'wal'
    })
    expect(await owner.connection.prepare('PRAGMA synchronous').get()).toEqual({ synchronous: 2 })
    expect(await owner.connection.prepare('PRAGMA fullfsync').get()).toEqual({ fullfsync: 0 })
    await expect(commit('epoch-2', 2)).rejects.toThrow('reject later row')
    expect(await owner.connection.prepare('SELECT epoch FROM journal_sessions').all()).toEqual([
      { epoch: 'epoch-1' }
    ])
    expect(await owner.connection.prepare('SELECT epoch, seq FROM journal_rows').all()).toEqual([
      { epoch: 'epoch-1', seq: 1 }
    ])
  } finally {
    await owner.close()
  }
})

it('admits maintenance before a queued foreground burst is exhausted and drains accepted work on close', async () => {
  const service = new JournalNativeService()
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const order: string[] = []
  const first = service.admit(async () => {
    entered.resolve()
    await release.promise
  })
  await entered.promise
  const foreground = Array.from({ length: 32 }, (_, index) =>
    service.admit(async () => {
      order.push(`f${index}`)
    })
  )
  const maintenance = service.admit(async () => {
    order.push('maintenance')
  }, true)
  const closed = service.close()
  await expect(service.admit(async () => {})).rejects.toThrow('closing')
  release.resolve()
  await Promise.all([first, ...foreground, maintenance, closed])
  expect(order.indexOf('maintenance')).toBeLessThan(32)
  expect(order.filter((name) => name.startsWith('f'))).toHaveLength(32)
})

it('attempts all mandatory committed effects before returning an adoption failure', async () => {
  const effects: string[] = []
  const failure = new Error('publication failed')
  await expect(
    settleJournalCommitAsync([
      () => {
        effects.push('draft')
        throw failure
      },
      async () => {
        await Promise.resolve()
        effects.push('receipt')
      },
      () => {
        effects.push('notification')
      }
    ])
  ).rejects.toBe(failure)
  expect(effects).toEqual(['draft', 'receipt', 'notification'])
})

it('retains recognizable expired attachment details across native worker error transport', () => {
  const expired = [{ uploadId: 'upload-1', name: 'design.png' }]
  const restored = restoreJournalSqlFailure(
    structuredClone(journalSqlFailure(new AgentSessionAttachmentExpiredError(expired)))
  )
  expect(restored).toBeInstanceOf(AgentSessionAttachmentExpiredError)
  expect(restored).toMatchObject({ expired })
})

it('transfers prepared claim references and their refusal names without duplication', () => {
  const effect: JournalPersistenceEffect = {
    kind: 'claim',
    claim: {
      sessionId: 'chat',
      now: 1,
      uploadIds: new Set(['upload-1', 'upload-2']),
      required: ['upload-1'],
      names: [{ uploadId: 'upload-1', name: 'design.png' }]
    }
  }
  let received: JournalPersistenceEffect | undefined
  for (const packet of journalUnitPackets([effect])) {
    if (received) {
      appendJournalUnitPacket(received, structuredClone(packet.effect))
    } else {
      received = structuredClone(packet.effect)
    }
  }
  expect(received).toEqual(effect)
  expect(effect.claim.names).toHaveLength(1)
})

it('awaits native founding, append, reconstruction and replacement through the published facade', async () => {
  const { JournalHostDatabase } = await import('./journal-host-database')
  const { openAgentSessionJournal } = await import('./journal-store-factory')
  const { restoreJournalAsync } = await import('./journal-async-open')
  const directory = join(root, 'host-lifecycle')
  const workerPath = join(root, 'journal-sql-worker-entry.js')
  const host = await JournalHostDatabase.open(directory, workerPath)
  const identity = {
    sessionId: 'chat',
    workspaceId: 'folder',
    hostId: 'local',
    agent: 'codex' as const,
    providerHandle: codexProviderHandle('thread-1')
  }
  const journal = await openAgentSessionJournal({ database: host, identity })
  try {
    expect(journal.cursor().sequence).toBe(1)
    await journal.appendItem(
      { provider: 'orca', clientMessageId: 'saved-status' },
      { kind: 'status', text: 'Saved status' },
      { fence: 0, turnScope: { kind: 'thread' } }
    )
    const saved = await host.read((read) => restoreJournalAsync(read, identity.sessionId))
    expect(saved?.damage).toBeNull()
    expect(saved?.newer).toBeNull()
    expect(saved?.state.items.size).toBe(1)
    const since = await journal.readSince({ epoch: journal.epoch, sequence: 1 })
    expect(since).toMatchObject({ ok: true, through: 2, cursor: journal.cursor() })
    const cursor = await journal.replaceEpochItems('handle_forked', 0, [])
    expect(journal.snapshot().items).toHaveLength(0)
    await journal.close()
    const reopened = await openAgentSessionJournal({ database: host, identity })
    try {
      expect(reopened.cursor()).toEqual(cursor)
      expect(reopened.snapshot().items).toEqual([])
    } finally {
      await reopened.close()
    }
  } finally {
    await journal.close()
    await host.close()
  }
})

it('drains an admitted reader before joint work without letting a queued reader deadlock its drain', async () => {
  const { JournalHostDatabase } = await import('./journal-host-database')
  const host = await JournalHostDatabase.open(
    join(root, 'host-joint-drain'),
    join(root, 'journal-sql-worker-entry.js')
  )
  const first = await host.snapshot(() => undefined)
  const events: string[] = []
  const joint = host.joint(
    async (filename) => {
      events.push('joint')
      const fixture = openJournalDatabase(filename)
      try {
        fixture.db
          .prepare(
            "INSERT INTO agent_session_store_meta(key, value) VALUES ('drain-proof', 'true')"
          )
          .run()
      } finally {
        fixture.db.close()
      }
    },
    () => {
      events.push('adopt')
    }
  )
  const queued = host.read(async (read) => {
    const value = await read
      .prepare("SELECT value FROM agent_session_store_meta WHERE key = 'drain-proof'")
      .get()
    events.push('read')
    return value
  })
  try {
    await first.close()
    await joint
    expect(await queued).toEqual({ value: 'true' })
    expect(events).toEqual(['joint', 'adopt', 'read'])
  } finally {
    await first.close()
    await host.close()
  }
})
