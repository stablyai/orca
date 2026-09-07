import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import type * as FsPromises from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Why: the debounced stats save must be async (off the main thread), while flush()
// stays synchronous for callers that cannot await. These tests pin both behaviors,
// prove the async path leaves no stray temp files, and — critically — prove an
// in-flight async write can never clobber the more-complete flush, at either of the
// two points it can park: before its temp write, and after, on the rename itself.

let userDataDir: string
const statsPath = (): string => join(userDataDir, 'orca-stats.json')

vi.mock('electron', () => ({
  app: { getPath: () => userDataDir }
}))

// A controllable gate over node:fs/promises writeFile so a test can hold a
// debounced async write "in flight" while it drives a synchronous shutdown flush.
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
    initStatsPath()
    const collector = new StatsCollector()

    collector.onAgentStart('pty-1', Date.now(), 'repo-1', 'wt-1')

    await vi.advanceTimersByTimeAsync(5_000)
    await vi.waitFor(() => {
      expect(readdirSync(userDataDir)).toContain('orca-stats.json')
    })

    // Proves the debounced path went through async fs/promises writeFile (a
    // revert to writeFileSync would leave this at 0).
    expect(gate.writeFileCalls).toBeGreaterThan(0)
    // No stray *.tmp files — the rename completed.
    expect(readdirSync(userDataDir).filter((f) => f.endsWith('.tmp'))).toHaveLength(0)

    const parsed = JSON.parse(readFileSync(statsPath(), 'utf-8'))
    expect(parsed.aggregates.totalAgentsSpawned).toBe(1)
    expect(Array.isArray(parsed.events)).toBe(true)
  })

  it('coalesces timer saves while one write is stalled', async () => {
    vi.useFakeTimers()
    const { StatsCollector, initStatsPath } = await importCollector()
    initStatsPath()
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

  it('retries a queued final snapshot after the active write fails', async () => {
    const { StatsCollector, initStatsPath } = await importCollector()
    initStatsPath()
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
    initStatsPath()
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
    initStatsPath()
    const collector = new StatsCollector()

    collector.onAgentStart('pty-2', Date.now())
    collector.flush()

    // Synchronous: the file exists immediately with no awaiting.
    const parsed = JSON.parse(readFileSync(statsPath(), 'utf-8'))
    expect(parsed.aggregates.totalAgentsSpawned).toBe(1)
  })

  it('an in-flight async write is vetoed by a shutdown flush (no data-loss clobber)', async () => {
    const { StatsCollector, initStatsPath } = await importCollector()
    initStatsPath()
    const collector = new StatsCollector()
    // White-box: drive the two writers directly so the race is deterministic
    const internals = collector as unknown as { enqueueWrite: () => Promise<void> }

    collector.onAgentStart('pty-a', 1_000)
    collector.onAgentStart('pty-b', 1_000)

    // Start the async write; it parks inside the blocked writeFile, before rename.
    // Why waitFor and not one tick: the writer awaits mkdir first, so the number of
    // microtask turns before writeFile is reached is an implementation detail.
    gate.blocked = true
    const inflight = internals.enqueueWrite()
    await vi.waitFor(() => expect(gate.writeFileCalls).toBeGreaterThan(0))

    // App quits: close out both agents and flush the COMPLETE state synchronously
    // (newer generation) while the async write is still parked.
    collector.onAgentStop('pty-a', 5_000)
    collector.onAgentStop('pty-b', 5_000)
    collector.flush()
    expect(JSON.parse(readFileSync(statsPath(), 'utf-8')).aggregates.totalAgentTimeMs).toBe(8_000)

    // Release the parked write; its older generation must be vetoed — the
    // flushed data must survive and no temp file may leak.
    gate.blocked = false
    gate.waiters.splice(0).forEach((resolve) => resolve())
    await inflight

    expect(JSON.parse(readFileSync(statsPath(), 'utf-8')).aggregates.totalAgentTimeMs).toBe(8_000)
    expect(readdirSync(userDataDir).filter((f) => f.endsWith('.tmp'))).toHaveLength(0)
  })

  it('an async write already parked on its rename cannot clobber a shutdown flush', async () => {
    // The generation guard alone stopped covering this once the swap became async: a writer
    // parked on `await rename` has already cleared the guard, so only removing the temp file
    // it would rename keeps the flush's fuller state from being overwritten.
    const { StatsCollector, initStatsPath } = await importCollector()
    initStatsPath()
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
