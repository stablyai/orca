import { createWorkerMaintenanceFixture } from '../../persistence/loading-store/profile-state-maintenance-fixture'
import type { Store } from '../../persistence/loading-store/store'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, existsSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import type * as NodeFs from 'node:fs'
import type * as NodeFsPromises from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// Sync fsync/rename on stalled mounts blocks the quit deadline's own event loop.

const testState = { dir: '' }

const fsCalls = vi.hoisted(() => {
  const calls = {
    recording: false,
    dirPrefix: '',
    syncCalls: [] as string[],
    holdAsync: null as Promise<void> | null,
    waitAsync: null as ((fn: string, target: string) => Promise<void> | null) | null,
    reset(): void {
      calls.syncCalls.length = 0
      calls.holdAsync = null
      calls.waitAsync = null
    },
    inScope(target: unknown): target is string {
      return (
        typeof target === 'string' && calls.dirPrefix !== '' && target.startsWith(calls.dirPrefix)
      )
    },
    recordSync(fn: string, target: unknown): void {
      if (calls.recording && calls.inScope(target)) {
        calls.syncCalls.push(`${fn}:${target}`)
      }
    }
  }
  return calls
})

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>()
  const patched: Record<string, unknown> = { ...actual }
  for (const name of Object.keys(actual)) {
    const original = (actual as unknown as Record<string, unknown>)[name]
    if (!name.endsWith('Sync') || typeof original !== 'function') {
      continue
    }
    const fn = original as (...args: unknown[]) => unknown
    const wrapper = (...args: unknown[]): unknown => {
      fsCalls.recordSync(name, args[0])
      return fn(...args)
    }
    patched[name] = Object.assign(wrapper, fn)
  }
  return { ...patched, default: patched }
})

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFsPromises>()
  const patched: Record<string, unknown> = { ...actual }
  for (const name of [
    'stat',
    'access',
    'rename',
    'copyFile',
    'rm',
    'mkdir',
    'open',
    'readFile',
    'writeFile',
    'link'
  ]) {
    const fn = (actual as unknown as Record<string, (...args: unknown[]) => unknown>)[name]
    patched[name] = async (...args: unknown[]): Promise<unknown> => {
      if (fsCalls.inScope(args[0]) && fsCalls.holdAsync) {
        await fsCalls.holdAsync
      }
      if (fsCalls.inScope(args[0]) && typeof args[0] === 'string') {
        await fsCalls.waitAsync?.(name, args[0])
      }
      return fn(...args)
    }
  }
  return { ...patched, default: patched }
})

vi.mock('../../ssh/config/ssh-config-parser', () => ({
  loadUserSshConfig: vi.fn(),
  sshConfigHostsToTargets: vi.fn()
}))

vi.mock('../../telemetry/client', () => ({ track: vi.fn() }))

vi.mock('../../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: vi.fn().mockReturnValue({ nth_repo_added: 2 })
}))

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (plaintext: string) => Buffer.from(`enc:${plaintext}`, 'utf-8'),
    decryptString: (ciphertext: Buffer) => ciphertext.toString('utf-8').slice('enc:'.length)
  }
}))

type TestStatsCollector = {
  onAgentStart(ptyId: string, at: number, repo?: string, worktree?: string): void
  getSummary(): { totalAgentsSpawned: number; totalAgentTimeMs: number }
  flushAsync(): Promise<void>
}

const profiles = new Map<string, Awaited<ReturnType<typeof createWorkerMaintenanceFixture>>>()
const stores: Store[] = []
const statsCollectors: TestStatsCollector[] = []
const releases: (() => void)[] = []

async function createStore(dir: string): Promise<Store> {
  testState.dir = dir
  const fixture = await createWorkerMaintenanceFixture({ directory: dir, profileId: 'quit-test' })
  profiles.set(dir, fixture)
  stores.push(fixture.store)
  fixture.store.updateUI({ activeView: 'terminal' })
  await fixture.store.flushPendingOrThrowAsync()
  await fixture.authority.drainBackups()
  return fixture.store
}

function readState(dir: string) {
  const profile = profiles.get(dir)
  if (!profile) {
    throw new Error('Missing test profile')
  }
  return profile.readState()
}

function stallCommit(dir: string) {
  const profile = profiles.get(dir)
  if (!profile) {
    throw new Error('Missing test profile')
  }
  const started = Promise.withResolvers<void>()
  const finish = Promise.withResolvers<void>()
  releases.push(finish.resolve)
  const original = profile.authority.writeCompleteSerializedDomains.bind(profile.authority)
  vi.spyOn(profile.authority, 'writeCompleteSerializedDomains').mockImplementationOnce(
    async (rows) => {
      started.resolve()
      await finish.promise
      await original(rows)
    }
  )
  return { started: started.promise, release: finish.resolve }
}

async function createStatsCollector(dir: string): Promise<TestStatsCollector> {
  testState.dir = dir
  const { StatsCollector, initStatsPath } = await import('../../stats/collector')
  initStatsPath(testState.dir)
  const stats = new StatsCollector()
  statsCollectors.push(stats)
  return stats
}

const dataFile = (dir: string): string => join(dir, 'orca-data.json')
const statsFile = (dir: string): string => join(dir, 'orca-stats.json')
const activeViewFile = (dir: string): string => join(dir, 'active-view.json')

describe('quit-path durable writes never park the main thread', () => {
  const dirs: string[] = []

  function makeDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'orca-quit-path-'))
    dirs.push(dir)
    return dir
  }

  beforeEach(() => {
    fsCalls.recording = false
    fsCalls.dirPrefix = ''
    fsCalls.reset()
  })

  afterEach(async () => {
    fsCalls.recording = false
    for (const release of releases.splice(0)) {
      release()
    }
    fsCalls.holdAsync = null
    fsCalls.waitAsync = null
    vi.useRealTimers()
    await Promise.all(stores.splice(0).map((store) => store.freezeWritesAsync()))
    await Promise.all(statsCollectors.splice(0).map((stats) => stats.flushAsync()))
    profiles.clear()
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('renderer unload staging issues no synchronous fs syscalls', async () => {
    const dir = makeDir()
    const store = await createStore(dir)

    fsCalls.dirPrefix = dir
    fsCalls.recording = true
    const leafId = '11111111-1111-4111-8111-111111111111'
    store.stageWorkspaceSessionBeforeUnload({
      activeRepoId: null,
      activeWorktreeId: null,
      activeTabId: null,
      tabsByWorktree: {
        'remote-repo::/remote': [
          {
            id: 'remote-tab',
            ptyId: 'remote-pty',
            worktreeId: 'remote-repo::/remote',
            title: 'Remote',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          }
        ]
      },
      terminalLayoutsByTabId: {
        'remote-tab': {
          root: { type: 'leaf', leafId },
          activeLeafId: leafId,
          expandedLeafId: null,
          buffersByLeafId: { [leafId]: 'remote-scrollback' }
        }
      },
      openFilesByWorktree: {}
    })
    fsCalls.recording = false

    expect(fsCalls.syncCalls).toEqual([])
    await store.flushAsync()
    const layout = readState(dir).workspaceSession.terminalLayoutsByTabId['remote-tab']
    const ref = layout.scrollbackRefsByLeafId[leafId]
    expect(layout.buffersByLeafId).toBeUndefined()
    expect(readFileSync(join(dir, 'terminal-scrollback', `${ref}.bin`), 'utf-8')).toBe(
      'remote-scrollback'
    )
  })

  it('the quit teardown deadline can now bound a wedged state flush', async () => {
    const dir = makeDir()
    const store = await createStore(dir)
    const { settleTeardownWithinDeadline } = await import('./quit-teardown-deadline')
    store.updateUI({ sidebarWidth: 999 })

    fsCalls.dirPrefix = dir
    const before = readState(dir).ui.sidebarWidth
    const gate = stallCommit(dir)
    const pending = store.flushAsync()
    await gate.started

    const outstanding = await settleTeardownWithinDeadline(
      [{ name: 'state', promise: pending }],
      25
    )

    expect(outstanding).toEqual(['state'])
    expect(readState(dir).ui.sidebarWidth).toBe(before)
    gate.release()
    await pending
    expect(readState(dir).ui.sidebarWidth).toBe(999)
  })

  it('store.flushAsync() drains an in-flight debounced write before writing', async () => {
    const dir = makeDir()
    const store = await createStore(dir)
    const gate = stallCommit(dir)
    vi.useFakeTimers()
    store.updateUI({ sidebarWidth: 100 })
    await vi.advanceTimersByTimeAsync(1_000)
    await gate.started

    store.updateUI({ sidebarWidth: 200 })
    const flushed = store.flushAsync()
    vi.useRealTimers()
    gate.release()
    await flushed

    expect(readState(dir).ui.sidebarWidth).toBe(200)
  })

  it('stats.flushAsync() wins over a debounced write already in flight', async () => {
    const dir = makeDir()
    const stats = await createStatsCollector(dir)
    stats.onAgentStart('pty-a', 1_000)
    stats.onAgentStart('pty-b', 1_000)

    const inflight = (stats as unknown as { enqueueWrite(): Promise<void> }).enqueueWrite.call(
      stats
    )
    await stats.flushAsync()
    await inflight

    const persisted = JSON.parse(readFileSync(statsFile(dir), 'utf-8'))
    expect(persisted.aggregates.totalAgentsSpawned).toBe(2)
    expect(persisted.aggregates.totalAgentTimeMs).toBeGreaterThan(0)
  })

  it('the quit flush is the last write — later mutations do not schedule another', async () => {
    // A later debounced write would race process exit.
    const dir = makeDir()
    const store = await createStore(dir)
    vi.useFakeTimers()
    store.updateUI({ sidebarWidth: 10 })
    await store.flushAsync()

    store.updateUI({ sidebarWidth: 20, activeView: 'tasks' })
    fsCalls.dirPrefix = dir
    fsCalls.recording = true
    await vi.runAllTimersAsync()
    fsCalls.recording = false

    expect(fsCalls.syncCalls).toEqual([])
    expect(readState(dir).ui.sidebarWidth).toBe(10)
    expect(JSON.parse(readFileSync(activeViewFile(dir), 'utf-8')).activeView).toBe('terminal')
  })

  it('sweeps orphaned state and stats temps while retaining fresh process temps', async () => {
    const dir = makeDir()
    const stateTemp = `${dataFile(dir)}.999999.1.orphan.tmp`
    const statsTemp = `${statsFile(dir)}.999999.1.orphan.tmp`
    const freshOtherProcessTemp = `${dataFile(dir)}.999998.1.live.tmp`
    writeFileSync(stateTemp, 'stale', 'utf-8')
    writeFileSync(statsTemp, 'stale', 'utf-8')
    writeFileSync(freshOtherProcessTemp, 'in-flight', 'utf-8')
    const staleSeconds = (Date.now() - 25 * 60 * 60 * 1000) / 1000
    utimesSync(stateTemp, staleSeconds, staleSeconds)
    utimesSync(statsTemp, staleSeconds, staleSeconds)

    const store = await createStore(dir)
    const stats = await createStatsCollector(dir)
    store.updateUI({ sidebarWidth: 123 })
    stats.onAgentStart('pty-sweep', Date.now())
    await Promise.all([store.flushAsync(), stats.flushAsync()])

    expect(existsSync(stateTemp)).toBe(false)
    expect(existsSync(dataFile(dir))).toBe(false)
    expect(existsSync(statsTemp)).toBe(false)
    expect(existsSync(freshOtherProcessTemp)).toBe(true)
  })
})
