import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import type * as FsPromises from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Keep debounce writes asynchronous and flush synchronous; parked writes before temp creation or at rename must never overwrite the newer flush or leak temp files.

let userDataDir: string
const statsPath = (): string => join(userDataDir, 'orca-stats.json')

vi.mock('electron', () => ({
  app: { getPath: () => userDataDir }
}))

// Hold async temp writes while exercising synchronous shutdown flush.
const gate = vi.hoisted(() => ({
  blocked: false,
  blockRename: false,
  waiters: [] as (() => void)[],
  renameWaiters: [] as (() => void)[],
  writeFileCalls: 0,
  renameCalls: 0,
  failNextWrite: false,
  failNextRenameEnoent: false
}))

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof FsPromises>('node:fs/promises')
  const writeFile = (async (...args: Parameters<typeof actual.writeFile>) => {
    gate.writeFileCalls += 1
    if (gate.blocked) {
      await new Promise<void>((resolve) => gate.waiters.push(resolve))
    }
    if (gate.failNextWrite) {
      gate.failNextWrite = false
      throw new Error('transient write failure')
    }
    return actual.writeFile(...args)
  }) as typeof actual.writeFile
  const rename = (async (...args: Parameters<typeof actual.rename>) => {
    gate.renameCalls += 1
    if (gate.failNextRenameEnoent) {
      gate.failNextRenameEnoent = false
      throw Object.assign(new Error('missing temp'), { code: 'ENOENT' })
    }
    if (gate.blockRename) {
      await new Promise<void>((resolve) => gate.renameWaiters.push(resolve))
    }
    return actual.rename(...args)
  }) as typeof actual.rename
  return { ...actual, writeFile, rename }
})

async function importCollector() {
  return import('./collector')
}

describe('StatsCollector async debounced save', () => {
  beforeEach(() => {
    userDataDir = mkdtempSync(join(tmpdir(), 'orca-stats-test-'))
    gate.blocked = false
    gate.blockRename = false
    gate.waiters = []
    gate.renameWaiters = []
    gate.writeFileCalls = 0
    gate.renameCalls = 0
    gate.failNextWrite = false
    gate.failNextRenameEnoent = false
    vi.resetModules()
  })

  afterEach(() => {
    rmSync(userDataDir, { recursive: true, force: true })
    vi.useRealTimers()
  })

  it('writes valid JSON via the async fs/promises path on the debounced timer, no stray temp files', async () => {
    vi.useFakeTimers()
    const { StatsCollector, initStatsPath } = await importCollector()
    initStatsPath(userDataDir)
    const collector = new StatsCollector()

    collector.onAgentStart('pty-1', Date.now(), 'repo-1', 'wt-1')

    await vi.advanceTimersByTimeAsync(5_000)
    await vi.waitFor(() => {
      expect(readdirSync(userDataDir)).toContain('orca-stats.json')
    })

    expect(gate.writeFileCalls).toBeGreaterThan(0)
    expect(readdirSync(userDataDir).filter((f) => f.endsWith('.tmp'))).toHaveLength(0)

    const parsed = JSON.parse(readFileSync(statsPath(), 'utf-8'))
    expect(parsed.aggregates.totalAgentsSpawned).toBe(1)
    expect(Array.isArray(parsed.events)).toBe(true)
  })

  it('coalesces timer saves while one write is stalled', async () => {
    vi.useFakeTimers()
    const { StatsCollector, initStatsPath } = await importCollector()
    initStatsPath(userDataDir)
    const collector = new StatsCollector()

    gate.blocked = true
    collector.onAgentStart('pty-1', 1_000)
    await vi.advanceTimersByTimeAsync(5_000)
    await vi.waitFor(() => expect(gate.writeFileCalls).toBe(1))

    for (let index = 2; index <= 5; index += 1) {
      collector.onAgentStart(`pty-${index}`, index * 1_000)
      await vi.advanceTimersByTimeAsync(5_000)
    }
    expect(gate.writeFileCalls).toBe(1)

    gate.blocked = false
    gate.waiters.splice(0).forEach((resolve) => resolve())
    await vi.waitFor(() => expect(gate.writeFileCalls).toBe(2))
    await (
      collector as unknown as { snapshotWriter: { waitForPendingWrite(): Promise<void> } }
    ).snapshotWriter.waitForPendingWrite()

    expect(JSON.parse(readFileSync(statsPath(), 'utf-8')).aggregates.totalAgentsSpawned).toBe(5)
  })

  it('bounds retained events while a stalled write prevents serialization', async () => {
    vi.useFakeTimers()
    const { StatsCollector, initStatsPath } = await importCollector()
    initStatsPath(userDataDir)
    const collector = new StatsCollector()

    gate.blocked = true
    collector.record({ type: 'agent_start', at: 0 })
    await vi.advanceTimersByTimeAsync(5_000)
    await vi.waitFor(() => expect(gate.writeFileCalls).toBe(1))

    const expectedEvents = Array.from({ length: 10_000 }, (_, index) => ({
      type: 'agent_start',
      at: index + 10_001
    }))
    try {
      for (let at = 1; at <= 20_000; at += 1) {
        collector.record({ type: 'agent_start', at })
        if (at % 5_000 === 0) {
          await vi.advanceTimersByTimeAsync(5_000)
          expect(collector['events'].length).toBeLessThanOrEqual(10_000)
        }
      }
      expect(gate.writeFileCalls).toBe(1)
      expect(collector['events']).toEqual(expectedEvents)
    } finally {
      const flushed = collector.flushAsync()
      gate.blocked = false
      gate.waiters.splice(0).forEach((resolve) => resolve())
      await flushed
    }

    const persisted = JSON.parse(readFileSync(statsPath(), 'utf-8'))
    expect(persisted.events).toEqual(expectedEvents)
    expect(persisted.aggregates).toMatchObject({
      totalAgentsSpawned: 20_001,
      firstEventAt: 0
    })
  })

  it('retries a queued final snapshot after the active write fails', async () => {
    const { StatsCollector, initStatsPath } = await importCollector()
    initStatsPath(userDataDir)
    const collector = new StatsCollector()
    const internals = collector as unknown as { enqueueWrite(): Promise<void> }
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})

    collector.onAgentStart('pty-final', 1_000)
    gate.blocked = true
    void internals.enqueueWrite()
    await vi.waitFor(() => expect(gate.writeFileCalls).toBe(1))
    const finalWrite = collector.flushAsync()

    gate.failNextWrite = true
    gate.blocked = false
    gate.waiters.splice(0).forEach((resolve) => resolve())
    await finalWrite
    errors.mockRestore()

    expect(gate.writeFileCalls).toBe(2)
    expect(JSON.parse(readFileSync(statsPath(), 'utf-8')).aggregates.totalAgentsSpawned).toBe(1)
  })

  it('does not treat a genuine rename ENOENT as a committed snapshot', async () => {
    const { StatsCollector, initStatsPath } = await importCollector()
    initStatsPath(userDataDir)
    const collector = new StatsCollector()
    const internals = collector as unknown as { enqueueWrite(): Promise<void> }
    collector.onAgentStart('pty-enoent', 1_000)

    gate.failNextRenameEnoent = true
    await expect(internals.enqueueWrite()).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(internals.enqueueWrite()).resolves.toBeUndefined()

    expect(JSON.parse(readFileSync(statsPath(), 'utf-8')).aggregates.totalAgentsSpawned).toBe(1)
  })

  it('flush() writes synchronously (no timer, immediately on disk)', async () => {
    const { StatsCollector, initStatsPath } = await importCollector()
    initStatsPath(userDataDir)
    const collector = new StatsCollector()

    collector.onAgentStart('pty-2', Date.now())
    collector.flush()

    const parsed = JSON.parse(readFileSync(statsPath(), 'utf-8'))
    expect(parsed.aggregates.totalAgentsSpawned).toBe(1)
  })

  it('an in-flight async write is vetoed by a shutdown flush (no data-loss clobber)', async () => {
    const { StatsCollector, initStatsPath } = await importCollector()
    initStatsPath(userDataDir)
    const collector = new StatsCollector()
    // Drive writers directly to make this race deterministic.
    const internals = collector as unknown as { enqueueWrite: () => Promise<void> }

    collector.onAgentStart('pty-a', 1_000)
    collector.onAgentStart('pty-b', 1_000)

    // Park at writeFile; await observation rather than fixed ticks because mkdir precedes it.
    gate.blocked = true
    const inflight = internals.enqueueWrite()
    await vi.waitFor(() => expect(gate.writeFileCalls).toBeGreaterThan(0))

    // Flush the newer completed-session generation while async write remains parked.
    collector.onAgentStop('pty-a', 5_000)
    collector.onAgentStop('pty-b', 5_000)
    collector.flush()
    expect(JSON.parse(readFileSync(statsPath(), 'utf-8')).aggregates.totalAgentTimeMs).toBe(8_000)

    // Release the old write; its generation must be vetoed without leaked temp files.
    gate.blocked = false
    gate.waiters.splice(0).forEach((resolve) => resolve())
    await inflight

    expect(JSON.parse(readFileSync(statsPath(), 'utf-8')).aggregates.totalAgentTimeMs).toBe(8_000)
    expect(readdirSync(userDataDir).filter((f) => f.endsWith('.tmp'))).toHaveLength(0)
  })

  it('an async write already parked on its rename cannot clobber a shutdown flush', async () => {
    // A writer parked at async rename has passed the generation guard; removing its temp file prevents it overwriting the newer flush.
    const { StatsCollector, initStatsPath } = await importCollector()
    initStatsPath(userDataDir)
    const collector = new StatsCollector()
    const internals = collector as unknown as { enqueueWrite: () => Promise<void> }

    collector.onAgentStart('pty-a', 1_000)
    collector.onAgentStart('pty-b', 1_000)

    gate.blockRename = true
    const inflight = internals.enqueueWrite()
    await vi.waitFor(() => expect(gate.renameCalls).toBeGreaterThan(0))

    collector.onAgentStop('pty-a', 5_000)
    collector.onAgentStop('pty-b', 5_000)
    collector.flush()
    expect(JSON.parse(readFileSync(statsPath(), 'utf-8')).aggregates.totalAgentTimeMs).toBe(8_000)

    gate.blockRename = false
    gate.renameWaiters.splice(0).forEach((resolve) => resolve())
    await expect(inflight).resolves.toBeUndefined()

    expect(JSON.parse(readFileSync(statsPath(), 'utf-8')).aggregates.totalAgentTimeMs).toBe(8_000)
    expect(readdirSync(userDataDir).filter((f) => f.endsWith('.tmp'))).toHaveLength(0)
  })
})
