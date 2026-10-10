import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PtyOwnershipRecordStore, getPtyOwnershipRecordPath } from './pty-ownership-record-store'
import {
  PtyOwnershipRecorder,
  parsePtyRootIdentities,
  type PtyRootIdentity,
  type SpawnedPtyIdentity
} from './pty-ownership-recorder'

const NOW = Date.parse('Mon Sep 21 12:00:00 2026')
const STARTED = 'Mon Sep 21 11:59:59 2026'
const temporaryDirs: string[] = []

function makeStore(): PtyOwnershipRecordStore {
  const dir = mkdtempSync(join(tmpdir(), 'orca-pty-recorder-'))
  temporaryDirs.push(dir)
  return new PtyOwnershipRecordStore(getPtyOwnershipRecordPath(dir, 42))
}

function spawned(sessionId: string, pid: number): SpawnedPtyIdentity {
  return { sessionId, incarnationId: 'inc-1', pid, slavePath: '/dev/ttys004' }
}

afterEach(() => {
  vi.useRealTimers()
  while (temporaryDirs.length > 0) {
    rmSync(temporaryDirs.pop()!, { recursive: true, force: true })
  }
})

describe('PtyOwnershipRecorder', () => {
  it('batches spawns into one probe and one store write, off the spawn call', async () => {
    const store = makeStore()
    const writes = vi.spyOn(store, 'upsertMany')
    const probes: number[][] = []
    const recorder = new PtyOwnershipRecorder({
      store,
      daemon: { pid: 400, startedAtMs: 1 },
      platform: 'darwin',
      now: () => NOW,
      isLive: () => true,
      probeIdentities: async (pids) => {
        probes.push([...pids])
        return new Map<number, PtyRootIdentity>(
          pids.map((pid) => [pid, { pgid: pid, startedAt: STARTED }])
        )
      }
    })

    recorder.record(spawned('a', 500))
    recorder.record(spawned('b', 510))
    // Nothing is probed or written while the spawn is still on the stack.
    expect(probes).toEqual([])
    expect(writes).not.toHaveBeenCalled()

    await recorder.flush()

    expect(probes).toEqual([[500, 510]])
    expect(writes).toHaveBeenCalledTimes(1)
    const read = store.read()
    expect(read.status === 'readable' && read.records.map((row) => row.root)).toEqual([
      { pid: 500, startedAt: STARTED },
      { pid: 510, startedAt: STARTED }
    ])
  })

  it('writes the batch once its delay elapses without anyone flushing it', async () => {
    vi.useFakeTimers()
    const store = makeStore()
    const writes = vi.spyOn(store, 'upsertMany')
    const recorder = new PtyOwnershipRecorder({
      store,
      daemon: { pid: 400, startedAtMs: 1 },
      platform: 'darwin',
      now: () => NOW,
      isLive: () => true,
      probeIdentities: async () => new Map(),
      batchDelayMs: 1_000
    })

    recorder.record(spawned('a', 500))
    await vi.advanceTimersByTimeAsync(999)
    expect(writes).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(writes).toHaveBeenCalledTimes(1)
  })

  it('never writes a start time for a root that is gone or was born after it was queued', async () => {
    const store = makeStore()
    const recorder = new PtyOwnershipRecorder({
      store,
      daemon: { pid: 400, startedAtMs: 1 },
      platform: 'darwin',
      now: () => NOW,
      isLive: (identity) => identity.sessionId !== 'gone',
      probeIdentities: async () =>
        new Map([
          [500, { pgid: 500, startedAt: 'Mon Sep 21 12:00:30 2026' }],
          [510, { pgid: 510, startedAt: STARTED }]
        ])
    })

    recorder.record(spawned('reused', 500))
    recorder.record(spawned('gone', 510))
    await recorder.flush()

    const read = store.read()
    expect(read.status === 'readable' && read.records).toMatchObject([
      { sessionId: 'reused', root: { pid: 500, startedAt: null }, pgids: [] }
    ])
  })
})

describe('PtyOwnershipRecorder.retire', () => {
  it('removes an ended session’s record but keeps a live respawn under the same id', async () => {
    const store = makeStore()
    const live = new Set(['a:inc-2'])
    const recorder = new PtyOwnershipRecorder({
      store,
      daemon: { pid: 400, startedAtMs: 1 },
      platform: 'darwin',
      now: () => NOW,
      isLive: (identity) => live.has(`${identity.sessionId}:${identity.incarnationId}`),
      probeIdentities: async () => new Map()
    })
    const row = (sessionId: string, incarnationId: string, pid: number) => ({
      sessionId,
      incarnationId,
      root: { pid, startedAt: STARTED },
      processes: [],
      pgids: [pid],
      tty: null,
      daemon: { pid: 400, startedAtMs: 1 },
      recordedAt: NOW
    })
    store.upsertMany([row('a', 'inc-1', 500), row('a', 'inc-2', 510), row('b', 'inc-1', 520)])

    recorder.retire('a')
    await recorder.flush()

    const read = store.read()
    expect(
      read.status === 'readable' &&
        read.records.map((entry) => entry.incarnationId + entry.sessionId)
    ).toEqual(['inc-2a', 'inc-1b'])
  })
})

describe('parsePtyRootIdentities', () => {
  it('reads one row per pid and skips rows that do not parse', () => {
    const parsed = parsePtyRootIdentities(
      ['  500   500 Mon Sep 21 09:00:00 2026', 'garbage', '510 0 Mon', ''].join('\n')
    )

    expect([...parsed]).toEqual([[500, { pgid: 500, startedAt: 'Mon Sep 21 09:00:00 2026' }]])
  })
})
