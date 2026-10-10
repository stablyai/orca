import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  parsePtyOwnershipRecord,
  ttyNameFromSlavePath,
  type PtyOwnershipRecord
} from './pty-ownership-record'
import {
  MAX_PTY_OWNERSHIP_RECORDS,
  PtyOwnershipRecordStore,
  getPtyOwnershipRecordPath
} from './pty-ownership-record-store'

const temporaryDirs: string[] = []

function makeStore(): { store: PtyOwnershipRecordStore; filePath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'orca-pty-owners-'))
  temporaryDirs.push(dir)
  const filePath = getPtyOwnershipRecordPath(dir, 42)
  return { store: new PtyOwnershipRecordStore(filePath), filePath }
}

function record(overrides: Partial<PtyOwnershipRecord> = {}): PtyOwnershipRecord {
  return {
    sessionId: 'session-a',
    incarnationId: 'inc-1',
    root: { pid: 500, startedAt: 'Mon Sep 21 09:00:00 2026' },
    processes: [{ pid: 601, startedAt: 'Mon Sep 21 09:00:05 2026' }],
    pgids: [500],
    tty: 'ttys004',
    daemon: { pid: 400, startedAtMs: 1_700_000_000_000 },
    recordedAt: 1_700_000_100_000,
    ...overrides
  }
}

afterEach(() => {
  while (temporaryDirs.length > 0) {
    rmSync(temporaryDirs.pop()!, { recursive: true, force: true })
  }
})

describe('PtyOwnershipRecordStore', () => {
  it('reads an absent file as no records, not as an unreadable store', () => {
    expect(makeStore().store.read()).toEqual({ status: 'readable', records: [] })
  })

  it('round-trips a record across a fresh reader, as a daemon restart would', () => {
    const { store, filePath } = makeStore()
    store.upsert(record())

    expect(new PtyOwnershipRecordStore(filePath).read()).toEqual({
      status: 'readable',
      records: [record()]
    })
  })

  it('keys by session and incarnation so a respawn does not overwrite the previous generation', () => {
    const { store } = makeStore()
    store.upsert(record({ incarnationId: 'inc-1' }))
    store.upsert(record({ incarnationId: 'inc-2', root: { pid: 700, startedAt: null } }))

    const read = store.read()
    expect(read.status === 'readable' && read.records.map((row) => row.incarnationId)).toEqual([
      'inc-1',
      'inc-2'
    ])
  })

  it('writes a batch of records in one rewrite, replacing any it already held', () => {
    const { store, filePath } = makeStore()
    store.upsert(record({ incarnationId: 'inc-1', pgids: [500] }))
    const before = readFileSync(filePath, 'utf8')
    store.upsertMany([
      record({ incarnationId: 'inc-1', pgids: [510] }),
      record({ incarnationId: 'inc-2' })
    ])

    const read = store.read()
    expect(before).not.toEqual(readFileSync(filePath, 'utf8'))
    expect(read.status === 'readable' && read.records.map((row) => row.pgids)).toEqual([
      [510],
      [500]
    ])
  })

  it('replaces a record in place on a second write for the same key', () => {
    const { store } = makeStore()
    store.upsert(record({ pgids: [500] }))
    store.upsert(record({ pgids: [500, 601] }))

    const read = store.read()
    expect(read.status === 'readable' && read.records).toEqual([record({ pgids: [500, 601] })])
  })

  it('drops only the unreadable rows, never the whole file', () => {
    const { store, filePath } = makeStore()
    writeFileSync(
      filePath,
      JSON.stringify({
        version: 1,
        records: [record(), { sessionId: 'broken' }, record({ incarnationId: 'inc-9' })]
      })
    )

    const read = store.read()
    expect(read.status === 'readable' && read.records.map((row) => row.incarnationId)).toEqual([
      'inc-1',
      'inc-9'
    ])
  })

  it('reports a corrupt file as unreadable rather than as an empty owner set', () => {
    const { store, filePath } = makeStore()
    writeFileSync(filePath, '{ not json')

    expect(store.read()).toEqual({ status: 'unreadable' })
  })

  it('refuses to rewrite an unreadable file, so a bad read cannot erase live records', () => {
    const { store, filePath } = makeStore()
    writeFileSync(filePath, '{ not json')

    store.upsert(record())

    expect(readFileSync(filePath, 'utf8')).toBe('{ not json')
  })

  it('applies a tick as replacements plus removals in one write', () => {
    const { store } = makeStore()
    store.upsert(record({ incarnationId: 'inc-1' }))
    store.upsert(record({ incarnationId: 'inc-2' }))

    store.applyTick(
      [record({ incarnationId: 'inc-2', pgids: [500, 900] })],
      ['session-a\u0000inc-1']
    )

    const read = store.read()
    expect(read.status === 'readable' && read.records).toEqual([
      record({ incarnationId: 'inc-2', pgids: [500, 900] })
    ])
  })

  it('never resurrects a re-derived record the store no longer holds', () => {
    const { store } = makeStore()
    store.upsert(record({ incarnationId: 'inc-1' }))

    store.applyTick([record({ incarnationId: 'gone' })], ['session-a\u0000inc-1'])

    expect(store.read()).toEqual({ status: 'readable', records: [] })
  })

  it('bounds the file so one pathological daemon cannot make every later read expensive', () => {
    const { store } = makeStore()
    for (let index = 0; index < MAX_PTY_OWNERSHIP_RECORDS + 5; index += 1) {
      store.upsert(record({ incarnationId: `inc-${index}` }))
    }

    const read = store.read()
    expect(read.status === 'readable' && read.records).toHaveLength(MAX_PTY_OWNERSHIP_RECORDS)
    expect(read.status === 'readable' && read.records[0].incarnationId).toBe('inc-5')
  })
})

describe('parsePtyOwnershipRecord', () => {
  it('accepts a row missing every soft field, so rows from an older build stay readable', () => {
    expect(
      parsePtyOwnershipRecord({
        sessionId: 'a',
        incarnationId: 'b',
        root: { pid: 1 },
        daemon: { pid: 2 },
        recordedAt: 0
      })
    ).toEqual({
      sessionId: 'a',
      incarnationId: 'b',
      root: { pid: 1, startedAt: null },
      processes: [],
      pgids: [],
      tty: null,
      daemon: { pid: 2, startedAtMs: null },
      recordedAt: 0
    })
  })

  it('drops junk out of a soft field rather than rejecting the row over it', () => {
    expect(
      parsePtyOwnershipRecord({
        sessionId: 'a',
        incarnationId: 'b',
        root: { pid: 1, startedAt: 7 },
        // An identity without a start time proves nothing, so it is not kept.
        processes: [{ pid: 601, startedAt: 'Mon' }, { pid: 602 }, { pid: -1, startedAt: 'x' }, 'x'],
        pgids: [500, -1, 'x', 0],
        tty: 4,
        daemon: { pid: 2, startedAtMs: Number.NaN },
        recordedAt: 0
      })
    ).toMatchObject({
      root: { startedAt: null },
      processes: [{ pid: 601, startedAt: 'Mon' }],
      pgids: [500],
      tty: null
    })
  })

  it('rejects a row whose identity or routing is unusable', () => {
    expect(
      parsePtyOwnershipRecord({ sessionId: '', incarnationId: 'b', root: { pid: 1 } })
    ).toBeNull()
    expect(
      parsePtyOwnershipRecord({
        sessionId: 'a',
        incarnationId: 'b',
        root: { pid: 0 },
        daemon: { pid: 2 },
        recordedAt: 0
      })
    ).toBeNull()
  })
})

describe('ttyNameFromSlavePath', () => {
  it('matches what ps prints in the tty column', () => {
    expect(ttyNameFromSlavePath('/dev/ttys004')).toBe('ttys004')
    expect(ttyNameFromSlavePath('/dev/pts/3')).toBe('pts/3')
    expect(ttyNameFromSlavePath(undefined)).toBeNull()
  })
})
