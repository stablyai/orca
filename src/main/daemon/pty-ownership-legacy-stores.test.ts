import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ProcessTableRow } from '../pty-process-table-parser'
import { DaemonOrphanReconciler } from './daemon-orphan-reconciler'
import {
  adoptLegacyPtyOwnershipStores,
  listLegacyPtyOwnershipStorePaths
} from './pty-ownership-legacy-stores'
import type { PtyOwnershipRecord } from './pty-ownership-record'
import { PtyOwnershipRecordStore, getPtyOwnershipRecordPath } from './pty-ownership-record-store'

const NOW = Date.parse('Mon Sep 21 12:00:00 2026')
const DAY_MS = 24 * 60 * 60_000
const OLD_DAEMON_STARTED = 'Mon Sep 21 08:59:00 2026'
const temporaryDirs: string[] = []

function makeRuntimeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'orca-pty-legacy-'))
  temporaryDirs.push(dir)
  return dir
}

function record(overrides: Partial<PtyOwnershipRecord> = {}): PtyOwnershipRecord {
  return {
    sessionId: 'session-a',
    incarnationId: 'inc-1',
    root: { pid: 500, startedAt: 'Mon Sep 21 09:00:00 2026' },
    processes: [],
    pgids: [500],
    tty: null,
    daemon: { pid: 400, startedAtMs: Date.parse(OLD_DAEMON_STARTED) },
    recordedAt: NOW - 60 * 60_000,
    ...overrides
  }
}

function records(store: PtyOwnershipRecordStore): PtyOwnershipRecord[] {
  const read = store.read()
  return read.status === 'readable' ? read.records : []
}

function adopt(dir: string, table: ProcessTableRow[]) {
  const into = new PtyOwnershipRecordStore(getPtyOwnershipRecordPath(dir, 42))
  const events: string[] = []
  const settled = adoptLegacyPtyOwnershipStores({
    paths: listLegacyPtyOwnershipStorePaths(dir, 42),
    into,
    table,
    selfPid: 900,
    daemonStartToleranceMs: 5_000,
    nowMs: NOW,
    maxRecordAgeMs: DAY_MS,
    log: (event) => events.push(event)
  })
  return { into, settled, events }
}

afterEach(() => {
  while (temporaryDirs.length > 0) {
    rmSync(temporaryDirs.pop()!, { recursive: true, force: true })
  }
})

describe('listLegacyPtyOwnershipStorePaths', () => {
  it('lists every other protocol version and nothing else', () => {
    const dir = makeRuntimeDir()
    for (const name of [
      'daemon-v41.pty-owners.json',
      'daemon-v42.pty-owners.json',
      'daemon-v43.pty-owners.json',
      'daemon-v41.pty-owners.json.tmp',
      'daemon-v41.pid'
    ]) {
      writeFileSync(join(dir, name), '')
    }

    expect(listLegacyPtyOwnershipStorePaths(dir, 42).sort()).toEqual([
      join(dir, 'daemon-v41.pty-owners.json'),
      join(dir, 'daemon-v43.pty-owners.json')
    ])
  })
})

describe('adoptLegacyPtyOwnershipStores', () => {
  it('merges a dead daemon’s records, keeping their age, and deletes the file', () => {
    const dir = makeRuntimeDir()
    const legacyPath = getPtyOwnershipRecordPath(dir, 41)
    new PtyOwnershipRecordStore(legacyPath).upsert(record())

    const { into, settled } = adopt(dir, [])

    expect(settled).toBe(1)
    expect(records(into)).toEqual([record()])
    expect(existsSync(legacyPath)).toBe(false)
  })

  it('never overwrites a record the current store already holds under the same key', () => {
    const dir = makeRuntimeDir()
    new PtyOwnershipRecordStore(getPtyOwnershipRecordPath(dir, 41)).upsert(
      record({ recordedAt: 1 })
    )
    new PtyOwnershipRecordStore(getPtyOwnershipRecordPath(dir, 42)).upsert(record())

    expect(records(adopt(dir, []).into)).toEqual([record()])
  })

  it('leaves the file to a daemon that is still running under the recorded identity', () => {
    const dir = makeRuntimeDir()
    const legacyPath = getPtyOwnershipRecordPath(dir, 41)
    new PtyOwnershipRecordStore(legacyPath).upsert(record())

    const { into, settled } = adopt(dir, [
      { pid: 400, ppid: 1, pgid: 400, startedAt: OLD_DAEMON_STARTED }
    ])

    expect(settled).toBe(0)
    expect(records(into)).toEqual([])
    expect(existsSync(legacyPath)).toBe(true)
  })

  it('keeps an unreadable file until it is older than any record could be', () => {
    const dir = makeRuntimeDir()
    const legacyPath = getPtyOwnershipRecordPath(dir, 41)
    writeFileSync(legacyPath, '{not json')

    expect(adopt(dir, []).settled).toBe(0)
    expect(existsSync(legacyPath)).toBe(true)

    const aged = (NOW - DAY_MS - 60_000) / 1000
    utimesSync(legacyPath, aged, aged)
    expect(adopt(dir, []).events).toEqual(['pty-orphan-legacy-records-expired'])
    expect(existsSync(legacyPath)).toBe(false)
  })
})

describe('DaemonOrphanReconciler with a prior protocol version’s store', () => {
  it('adopts it even when its own store is empty', async () => {
    const dir = makeRuntimeDir()
    const legacyPath = getPtyOwnershipRecordPath(dir, 41)
    new PtyOwnershipRecordStore(legacyPath).upsert(record())
    const store = new PtyOwnershipRecordStore(getPtyOwnershipRecordPath(dir, 42))
    let captures = 0

    await new DaemonOrphanReconciler({
      store,
      daemonStartedAtMs: NOW,
      listLegacyStores: () => listLegacyPtyOwnershipStorePaths(dir, 42),
      listLiveSessions: () => [],
      log: () => {},
      platform: 'darwin',
      selfPid: 900,
      now: () => NOW,
      readTable: async () => {
        captures += 1
        return {
          rows: [{ pid: 500, ppid: 1, pgid: 500, startedAt: 'Mon Sep 21 09:00:00 2026' }],
          capturedAtMs: NOW
        }
      }
    }).runOnce()

    expect(captures).toBe(1)
    expect(existsSync(legacyPath)).toBe(false)
    // Its recorded root is still running, so it now waits on this store for a second observation.
    expect(records(store)).toEqual([record()])
  })
})
