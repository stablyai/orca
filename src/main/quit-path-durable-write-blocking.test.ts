import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, existsSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import type * as NodeFs from 'node:fs'
import type * as NodeFsPromises from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { installFakeAppEnvironment } from '../../config/scripts/vitest-host-ports-setup'

// Why these tests exist: will-quit used to run stats.flush() and store.flush() synchronously,
// before preventDefault(). On a stalled network profile mount those fsync/rename syscalls park
// the Electron main thread uninterruptibly — the app stops repainting and Force Quit stops
// working. The teardown deadline cannot rescue that, because its own timer needs the thread it
// would have to bound. The fix is to make the quit path awaitable, not to bound it.

const testState = { dir: '' }

const fsCalls = vi.hoisted(() => {
  const calls = {
    recording: false,
    dirPrefix: '',
    syncCalls: [] as string[],
    /** Set to park every in-scope async fs call — a stalled mount, without stalling the thread. */
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
  for (const name of ['stat', 'access', 'rename', 'copyFile', 'rm', 'mkdir', 'open', 'writeFile']) {
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

vi.mock('./ssh/ssh-config-parser', () => ({
  loadUserSshConfig: vi.fn(),
  sshConfigHostsToTargets: vi.fn()
}))

vi.mock('./telemetry/client', () => ({ track: vi.fn() }))

vi.mock('./telemetry/cohort-classifier', () => ({
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

type TestStore = {
  updateUI(updates: { sidebarWidth?: number; activeView?: string }): void
  setGitHubCache(cache: unknown): void
  waitForPendingWrite(): Promise<void>
  flushAsync(): Promise<void>
  flushOrThrow(): void
  stageWorkspaceSessionBeforeUnload(session: Record<string, unknown>): void
}

type TestStatsCollector = {
  onAgentStart(ptyId: string, at: number, repo?: string, worktree?: string): void
  getSummary(): { totalAgentsSpawned: number; totalAgentTimeMs: number }
  flushAsync(): Promise<void>
}

async function createStore(dir: string): Promise<TestStore> {
  testState.dir = dir
  vi.resetModules()
  const { Store, initDataPath } = await import('./persistence')
  // Why: userData resolves through AppEnvironment; point it at this file's temp dir.
  installFakeAppEnvironment({ getPath: () => testState.dir })
  initDataPath()
  return new Store() as unknown as TestStore
}

async function createStatsCollector(dir: string): Promise<TestStatsCollector> {
  testState.dir = dir
  vi.resetModules()
  const { StatsCollector, initStatsPath } = await import('./stats/collector')
  initStatsPath()
  return new StatsCollector() as unknown as TestStatsCollector
}

const dataFile = (dir: string): string => join(dir, 'orca-data.json')
const statsFile = (dir: string): string => join(dir, 'orca-stats.json')
const activeViewFile = (dir: string): string => join(dir, 'active-view.json')

/** Resolves once the macrotask queue turns over — false if the main thread is parked. */
function eventLoopTurned(): Promise<boolean> {
  return new Promise((resolve) => setTimeout(() => resolve(true), 0))
}

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

  afterEach(() => {
    vi.useRealTimers()
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('store.flushAsync() issues no synchronous fs syscalls', async () => {
    const dir = makeDir()
    const store = await createStore(dir)
    store.updateUI({ sidebarWidth: 321 })

    fsCalls.dirPrefix = dir
    fsCalls.recording = true
    await store.flushAsync()
    fsCalls.recording = false

    expect(fsCalls.syncCalls).toEqual([])
    expect(JSON.parse(readFileSync(dataFile(dir), 'utf-8')).ui.sidebarWidth).toBe(321)
  })

  it('renderer unload staging issues no synchronous fs syscalls', async () => {
    const dir = makeDir()
    const store = await createStore(dir)

    fsCalls.dirPrefix = dir
    fsCalls.recording = true
    const leafId = '11111111-1111-4111-8111-111111111111'
    store.stageWorkspaceSessionBeforeUnload({
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
    const layout = JSON.parse(readFileSync(dataFile(dir), 'utf-8')).workspaceSession
      .terminalLayoutsByTabId['remote-tab']
    const ref = layout.scrollbackRefsByLeafId[leafId]
    expect(layout.buffersByLeafId).toBeUndefined()
    expect(readFileSync(join(dir, 'terminal-scrollback', `${ref}.bin`), 'utf-8')).toBe(
      'remote-scrollback'
    )
  })

  it('store.flushAsync() also moves the active-view and github-cache sidecars off the thread', async () => {
    const dir = makeDir()
    const staleCacheTemp = join(dir, 'orca-github-cache.json.999999.1.orphan.tmp')
    writeFileSync(staleCacheTemp, 'stale', 'utf-8')
    const staleSeconds = (Date.now() - 25 * 60 * 60 * 1000) / 1000
    utimesSync(staleCacheTemp, staleSeconds, staleSeconds)
    const store = await createStore(dir)
    store.updateUI({ activeView: 'activity' })
    store.setGitHubCache({ pullRequestsByWorktree: {} })

    fsCalls.dirPrefix = dir
    fsCalls.recording = true
    await store.flushAsync()
    fsCalls.recording = false

    expect(fsCalls.syncCalls).toEqual([])
    expect(JSON.parse(readFileSync(activeViewFile(dir), 'utf-8')).activeView).toBe('activity')
    expect(existsSync(join(dir, 'orca-github-cache.json'))).toBe(true)
    expect(existsSync(staleCacheTemp)).toBe(false)
  })

  it('stats.flushAsync() issues no synchronous fs syscalls', async () => {
    const dir = makeDir()
    const stats = await createStatsCollector(dir)
    stats.onAgentStart('pty-1', 1_000, 'repo', 'worktree')

    fsCalls.dirPrefix = dir
    fsCalls.recording = true
    await stats.flushAsync()
    fsCalls.recording = false

    expect(fsCalls.syncCalls).toEqual([])
    expect(JSON.parse(readFileSync(statsFile(dir), 'utf-8')).aggregates.totalAgentsSpawned).toBe(1)
  })

  it('stats.flushAsync() closes out live agents before it returns, not when its write lands', async () => {
    // will-quit calls this before killAllPty(), which skips runtime.onPtyExit(). If the
    // closeout moved behind the await, every agent still running at quit would lose its
    // session time — the whole reason the flush is ordered ahead of the kill.
    const dir = makeDir()
    const stats = await createStatsCollector(dir)
    stats.onAgentStart('pty-1', Date.now() - 4_000)

    fsCalls.dirPrefix = dir
    fsCalls.holdAsync = new Promise(() => {})
    const pending = stats.flushAsync()

    expect(stats.getSummary().totalAgentTimeMs).toBeGreaterThan(0)
    void pending
  })

  it('a stalled mount leaves the event loop live instead of parking it', async () => {
    const dir = makeDir()
    const store = await createStore(dir)
    store.updateUI({ sidebarWidth: 654 })

    fsCalls.dirPrefix = dir
    // Every fs call from here on never resolves — the mount is gone.
    fsCalls.holdAsync = new Promise(() => {})
    const pending = store.flushAsync()

    // The whole point: timers still fire, so the app still repaints and the quit
    // deadline below can still be reached. A sync flush would have blocked here.
    await expect(eventLoopTurned()).resolves.toBe(true)
    void pending
  })

  it('the quit teardown deadline can now bound a wedged state flush', async () => {
    const dir = makeDir()
    const store = await createStore(dir)
    const { settleTeardownWithinDeadline } = await import('./quit-teardown-deadline')
    store.updateUI({ sidebarWidth: 999 })

    fsCalls.dirPrefix = dir
    fsCalls.holdAsync = new Promise(() => {})
    const pending = store.flushAsync()

    const outstanding = await settleTeardownWithinDeadline(
      [{ name: 'state', promise: pending }],
      25
    )

    expect(outstanding).toEqual(['state'])
    // Cut short before the rename, so the previous file is still whole — bounded loss, no corruption.
    expect(existsSync(dataFile(dir))).toBe(false)
  })

  it('store.flushAsync() drains an in-flight debounced write before writing', async () => {
    vi.useFakeTimers()
    const dir = makeDir()
    const store = await createStore(dir)
    store.updateUI({ sidebarWidth: 100 })
    await vi.advanceTimersByTimeAsync(1_000)

    store.updateUI({ sidebarWidth: 200 })
    const flushed = store.flushAsync()
    await vi.runAllTimersAsync()
    await flushed

    expect(JSON.parse(readFileSync(dataFile(dir), 'utf-8')).ui.sidebarWidth).toBe(200)
  })

  it('store.flushAsync() is one idempotent final barrier', async () => {
    const dir = makeDir()
    const store = await createStore(dir)
    store.updateUI({ sidebarWidth: 777 })

    const first = store.flushAsync()
    const second = store.flushAsync()

    expect(second).toBe(first)
    expect(() => store.flushOrThrow()).toThrow('final persistence')
    await first
    expect(JSON.parse(readFileSync(dataFile(dir), 'utf-8')).ui.sidebarWidth).toBe(777)
  })

  it('serializes github-cache snapshots and keeps the newest generation', async () => {
    const dir = makeDir()
    const store = await createStore(dir)
    let releaseWrite!: () => void
    const writeRelease = new Promise<void>((resolve) => {
      releaseWrite = resolve
    })
    let signalWrite!: () => void
    const writeStarted = new Promise<void>((resolve) => {
      signalWrite = resolve
    })
    let held = false
    fsCalls.dirPrefix = dir
    fsCalls.recording = true
    fsCalls.waitAsync = (fn, target) => {
      if (held || fn !== 'writeFile' || !target.includes('orca-github-cache.json')) {
        return null
      }
      held = true
      signalWrite()
      return writeRelease
    }

    store.setGitHubCache({ version: 1 })
    const finalFlush = store.flushAsync()
    await writeStarted
    store.setGitHubCache({ version: 2 })

    releaseWrite()
    await finalFlush
    fsCalls.recording = false

    expect(JSON.parse(readFileSync(join(dir, 'orca-github-cache.json'), 'utf-8'))).toEqual({
      version: 2
    })
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

    // Serialized writes plus the generation guard: the flush's fuller state survives.
    const persisted = JSON.parse(readFileSync(statsFile(dir), 'utf-8'))
    expect(persisted.aggregates.totalAgentsSpawned).toBe(2)
    expect(persisted.aggregates.totalAgentTimeMs).toBeGreaterThan(0)
  })

  it('the quit flush is the last write — later mutations do not schedule another', async () => {
    // A teardown step that touches the store would otherwise arm a debounced write with
    // nothing awaiting it, leaving a rename to race the process exit.
    vi.useFakeTimers()
    const dir = makeDir()
    const store = await createStore(dir)
    store.updateUI({ sidebarWidth: 10 })
    await store.flushAsync()

    store.updateUI({ sidebarWidth: 20, activeView: 'tasks' })
    fsCalls.dirPrefix = dir
    fsCalls.recording = true
    await vi.runAllTimersAsync()
    fsCalls.recording = false

    expect(fsCalls.syncCalls).toEqual([])
    expect(JSON.parse(readFileSync(dataFile(dir), 'utf-8')).ui.sidebarWidth).toBe(10)
    expect(JSON.parse(readFileSync(activeViewFile(dir), 'utf-8')).activeView).toBe('terminal')
  })

  it('sweeps orphaned state and stats temp files before the final write', async () => {
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
    expect(existsSync(statsTemp)).toBe(false)
    expect(existsSync(freshOtherProcessTemp)).toBe(true)
  })

  it('store.flushAsync() resolves instead of throwing when the profile mount rejects writes', async () => {
    const dir = makeDir()
    const store = await createStore(dir)
    store.updateUI({ sidebarWidth: 42 })
    rmSync(dir, { recursive: true, force: true })

    // It joins the teardown barrier; a rejection there is noise that must not cancel the quit.
    await expect(store.flushAsync()).resolves.toBeUndefined()
  })
})
