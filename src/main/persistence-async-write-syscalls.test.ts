import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import type * as NodeFs from 'node:fs'
import type * as NodeFsPromises from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const testState = { dir: '' }

const fsCalls = vi.hoisted(() => {
  const blocker = new Int32Array(new SharedArrayBuffer(4))
  const calls = {
    recording: false,
    dirPrefix: '',
    /** When > 0, every recorded sync call parks the main thread this long — a stalled mount in miniature. */
    stallMs: 0,
    syncCalls: [] as string[],
    asyncCalls: [] as string[],
    failAsync: null as ((fn: string, target: string) => NodeJS.ErrnoException | null) | null,
    beforeAsync: null as ((fn: string, target: string) => void) | null,
    waitAsync: null as ((fn: string, target: string) => Promise<void> | null) | null,
    reset(): void {
      calls.syncCalls.length = 0
      calls.asyncCalls.length = 0
      calls.stallMs = 0
      calls.failAsync = null
      calls.beforeAsync = null
      calls.waitAsync = null
    },
    inScope(target: unknown): target is string {
      return (
        calls.recording &&
        typeof target === 'string' &&
        calls.dirPrefix !== '' &&
        target.startsWith(calls.dirPrefix)
      )
    },
    recordSync(fn: string, target: unknown): void {
      if (!calls.inScope(target)) {
        return
      }
      calls.syncCalls.push(`${fn}:${target}`)
      if (calls.stallMs > 0) {
        // Atomics.wait blocks the thread the way an uninterruptible syscall does.
        Atomics.wait(blocker, 0, 0, calls.stallMs)
      }
    },
    recordAsync(fn: string, target: unknown): NodeJS.ErrnoException | null {
      if (!calls.inScope(target)) {
        return null
      }
      calls.asyncCalls.push(`${fn}:${target}`)
      calls.beforeAsync?.(fn, target)
      return calls.failAsync?.(fn, target) ?? null
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
  for (const name of ['stat', 'access', 'rename', 'copyFile', 'rm', 'mkdir', 'open']) {
    const fn = (actual as unknown as Record<string, (...args: unknown[]) => unknown>)[name]
    patched[name] = async (...args: unknown[]): Promise<unknown> => {
      const failure = fsCalls.recordAsync(name, args[0])
      if (failure) {
        throw failure
      }
      if (typeof args[0] === 'string') {
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

// Deterministic cipher so two stores driven through identical mutations produce identical bytes.
vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (plaintext: string) => Buffer.from(`enc:${plaintext}`, 'utf-8'),
    decryptString: (ciphertext: Buffer) => ciphertext.toString('utf-8').slice('enc:'.length)
  }
}))

const BACKUP_COUNT = 5
const BACKUP_MIN_INTERVAL_MS = 60 * 60 * 1000
const PAST_ROTATION_INTERVAL_MS = BACKUP_MIN_INTERVAL_MS * 2
const SAVE_DEBOUNCE_MS = 1_000

const ROTATION_INTERLEAVE_CASES = [
  ['initial access', 'access', ''],
  ['oldest removal', 'rm', '.bak.4'],
  ['slot access', 'access', '.bak.0'],
  ['slot rename', 'rename', '.bak.0'],
  ['final copy', 'copyFile', '']
] as const

type TestStore = {
  updateUI(updates: { sidebarWidth: number }): void
  setGitHubCache(cache: { pr: Record<string, never>; issue: Record<string, never> }): void
  waitForPendingWrite(): Promise<void>
  flushOrThrow(): void
  flushPendingAsync(): Promise<void>
  flushPendingOrThrowAsync(): Promise<void>
}

async function createStore(dir: string): Promise<TestStore> {
  testState.dir = dir
  vi.resetModules()
  const { Store, initDataPath } = await import('./persistence')
  initDataPath()
  return new Store() as unknown as TestStore
}

function dataFile(dir: string): string {
  return join(dir, 'orca-data.json')
}

function seedStaleBackup(dir: string): void {
  const path = `${dataFile(dir)}.bak.0`
  writeFileSync(path, '{"stale":true}', 'utf-8')
  const staleSeconds = (Date.now() - PAST_ROTATION_INTERVAL_MS) / 1000
  utimesSync(path, staleSeconds, staleSeconds)
}

function ringSnapshot(dir: string): Record<string, string> {
  const snapshot: Record<string, string> = {}
  for (const name of readdirSync(dir).sort()) {
    if (name === 'orca-data.json' || name.startsWith('orca-data.json.bak.')) {
      snapshot[name] = readFileSync(join(dir, name), 'utf-8')
    }
  }
  return snapshot
}

describe('async persistence write path avoids synchronous fs syscalls', () => {
  const dirs: string[] = []

  function makeDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'orca-async-write-'))
    dirs.push(dir)
    return dir
  }

  beforeEach(() => {
    fsCalls.recording = false
    fsCalls.dirPrefix = ''
    fsCalls.reset()
    vi.useFakeTimers()
  })

  afterEach(() => {
    fsCalls.recording = false
    vi.useRealTimers()
    while (dirs.length > 0) {
      rmSync(dirs.pop() as string, { recursive: true, force: true })
    }
  })

  async function recordAsyncSave(
    store: TestStore,
    dir: string,
    sidebarWidth: number
  ): Promise<void> {
    store.updateUI({ sidebarWidth })
    fsCalls.dirPrefix = dir
    fsCalls.recording = true
    try {
      vi.advanceTimersByTime(PAST_ROTATION_INTERVAL_MS)
      await store.waitForPendingWrite()
    } finally {
      fsCalls.recording = false
    }
  }

  it('issues no sync fs syscall under the profile dir when rotation runs with an empty ring', async () => {
    const dir = makeDir()
    const store = await createStore(dir)

    await recordAsyncSave(store, dir, 301)

    expect(fsCalls.syncCalls).toEqual([])
    // Rotation must actually have happened, else the assertion above is vacuous.
    expect(ringSnapshot(dir)['orca-data.json.bak.0']).toBe(readFileSync(dataFile(dir), 'utf-8'))
  })

  it('uses an awaited stat, not statSync, for the backup rotation interval check', async () => {
    const dir = makeDir()
    const store = await createStore(dir)
    seedStaleBackup(dir)

    await recordAsyncSave(store, dir, 302)

    expect(fsCalls.syncCalls).toEqual([])
    expect(fsCalls.asyncCalls).toContain(`stat:${dataFile(dir)}.bak.0`)
  })

  it('issues no sync fs syscall while rotating a saturated ring', async () => {
    const dir = makeDir()
    const store = await createStore(dir)

    // One more save than the ring holds, so the oldest slot is evicted and every slot renames.
    for (let i = 0; i <= BACKUP_COUNT; i++) {
      await recordAsyncSave(store, dir, 310 + i)
    }

    expect(fsCalls.syncCalls).toEqual([])
    const ring = ringSnapshot(dir)
    expect(Object.keys(ring)).toContain(`orca-data.json.bak.${BACKUP_COUNT - 1}`)
    expect(Object.keys(ring)).not.toContain(`orca-data.json.bak.${BACKUP_COUNT}`)
  })

  it('lets a main-thread timer keep firing while a rotating save is in flight', async () => {
    // A recorded sync call stalls long enough for the heartbeat to catch it.
    vi.useRealTimers()
    const dir = makeDir()
    const store = await createStore(dir)
    seedStaleBackup(dir)
    // Generous stall so ordinary scheduler/GC jitter can't reach the threshold on a loaded CI box.
    const stallMs = 500

    let lastTick = Date.now()
    let worstGapMs = 0
    const heartbeat = setInterval(() => {
      const now = Date.now()
      worstGapMs = Math.max(worstGapMs, now - lastTick)
      lastTick = now
    }, 10)

    try {
      store.updateUI({ sidebarWidth: 341 })
      fsCalls.dirPrefix = dir
      fsCalls.stallMs = stallMs
      fsCalls.recording = true
      lastTick = Date.now()
      await new Promise((resolve) => setTimeout(resolve, SAVE_DEBOUNCE_MS + 200))
      await store.waitForPendingWrite()
    } finally {
      fsCalls.recording = false
      clearInterval(heartbeat)
    }

    expect(worstGapMs).toBeLessThan(stallMs)
    // The save really happened, so a small gap isn't just an absent write.
    expect(ringSnapshot(dir)['orca-data.json.bak.0']).toBe(readFileSync(dataFile(dir), 'utf-8'))
  }, 20_000)

  it('skips rotation when a sync flush rotated during the rotation-interval await', async () => {
    // The acquired owner keeps rotation when the flush skips the ring.
    const dir = makeDir()
    const store = await createStore(dir)
    seedStaleBackup(dir)
    const staleBackup = readFileSync(`${dataFile(dir)}.bak.0`, 'utf-8')

    store.updateUI({ sidebarWidth: 361 })
    fsCalls.dirPrefix = dir
    fsCalls.recording = true
    let flushed = false
    fsCalls.beforeAsync = (fn, target) => {
      if (flushed || fn !== 'stat' || !target.endsWith('.bak.0')) {
        return
      }
      flushed = true
      store.updateUI({ sidebarWidth: 362 })
      store.flushOrThrow()
    }
    try {
      vi.advanceTimersByTime(PAST_ROTATION_INTERVAL_MS)
      await store.waitForPendingWrite()
    } finally {
      fsCalls.recording = false
      fsCalls.beforeAsync = null
    }

    expect(flushed).toBe(true)
    const ring = ringSnapshot(dir)
    expect(ring['orca-data.json.bak.0']).toBe(ring['orca-data.json'])
    expect(ring['orca-data.json.bak.1']).toBe(staleBackup)
    expect(ring['orca-data.json.bak.2']).toBeUndefined()
  })

  it('a sync checkpoint vetoes an async write already parked on rename', async () => {
    const dir = makeDir()
    const store = await createStore(dir)
    let releaseRename!: () => void
    const renameRelease = new Promise<void>((resolve) => {
      releaseRename = resolve
    })
    let signalRename!: () => void
    const renameStarted = new Promise<void>((resolve) => {
      signalRename = resolve
    })
    fsCalls.waitAsync = (fn, target) => {
      if (fn !== 'rename' || target === dataFile(dir) || !target.startsWith(dataFile(dir))) {
        return null
      }
      signalRename()
      return renameRelease
    }

    fsCalls.dirPrefix = dir
    fsCalls.recording = true
    store.updateUI({ sidebarWidth: 501 })
    vi.advanceTimersByTime(SAVE_DEBOUNCE_MS)
    const pending = store.waitForPendingWrite()
    await renameStarted

    store.updateUI({ sidebarWidth: 502 })
    store.flushOrThrow()
    expect(JSON.parse(readFileSync(dataFile(dir), 'utf-8')).ui.sidebarWidth).toBe(502)

    releaseRename()
    await pending
    fsCalls.recording = false
    fsCalls.waitAsync = null

    expect(JSON.parse(readFileSync(dataFile(dir), 'utf-8')).ui.sidebarWidth).toBe(502)
    expect(readdirSync(dir).filter((name) => name.endsWith('.tmp'))).toHaveLength(0)
  })

  it('retries a genuine ENOENT instead of marking the state persisted', async () => {
    const dir = makeDir()
    const store = await createStore(dir)
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    fsCalls.dirPrefix = dir
    fsCalls.recording = true
    fsCalls.failAsync = (fn, target) =>
      fn === 'rename' && target.startsWith(dataFile(dir)) && !target.includes('.bak.')
        ? Object.assign(new Error('mount disappeared'), { code: 'ENOENT' })
        : null

    store.updateUI({ sidebarWidth: 511 })
    await store.flushPendingAsync()
    expect(existsSync(dataFile(dir))).toBe(false)

    fsCalls.failAsync = null
    await store.flushPendingAsync()
    fsCalls.recording = false
    errors.mockRestore()

    expect(JSON.parse(readFileSync(dataFile(dir), 'utf-8')).ui.sidebarWidth).toBe(511)
  })

  it('the throwing async barrier drains mutations made during its write', async () => {
    const dir = makeDir()
    const store = await createStore(dir)
    let releaseRename!: () => void
    const renameRelease = new Promise<void>((resolve) => {
      releaseRename = resolve
    })
    let signalRename!: () => void
    const renameStarted = new Promise<void>((resolve) => {
      signalRename = resolve
    })
    let held = false
    fsCalls.waitAsync = (fn, target) => {
      if (held || fn !== 'rename' || !target.startsWith(dataFile(dir))) {
        return null
      }
      held = true
      signalRename()
      return renameRelease
    }
    fsCalls.dirPrefix = dir
    fsCalls.recording = true

    store.updateUI({ sidebarWidth: 601 })
    const barrier = store.flushPendingOrThrowAsync()
    await renameStarted
    store.updateUI({ sidebarWidth: 602 })
    releaseRename()
    await barrier
    fsCalls.recording = false

    expect(JSON.parse(readFileSync(dataFile(dir), 'utf-8')).ui.sidebarWidth).toBe(602)
  })

  it('bounds a best-effort flush to one state generation', async () => {
    const dir = makeDir()
    const store = await createStore(dir)
    let releaseRename!: () => void
    const renameRelease = new Promise<void>((resolve) => {
      releaseRename = resolve
    })
    let signalRename!: () => void
    const renameStarted = new Promise<void>((resolve) => {
      signalRename = resolve
    })
    let held = false
    fsCalls.waitAsync = (fn, target) => {
      if (held || fn !== 'rename' || !target.startsWith(dataFile(dir))) {
        return null
      }
      held = true
      signalRename()
      return renameRelease
    }
    fsCalls.dirPrefix = dir
    fsCalls.recording = true

    store.updateUI({ sidebarWidth: 621 })
    const flush = store.flushPendingAsync()
    await renameStarted
    store.updateUI({ sidebarWidth: 622 })
    releaseRename()
    await flush
    fsCalls.recording = false

    expect(JSON.parse(readFileSync(dataFile(dir), 'utf-8')).ui.sidebarWidth).toBe(621)

    await store.flushPendingOrThrowAsync()
    expect(JSON.parse(readFileSync(dataFile(dir), 'utf-8')).ui.sidebarWidth).toBe(622)
  })

  it('the throwing async barrier drains mutations made during sidecar I/O', async () => {
    const dir = makeDir()
    const store = await createStore(dir)
    let releaseRename!: () => void
    const renameRelease = new Promise<void>((resolve) => {
      releaseRename = resolve
    })
    let signalRename!: () => void
    const renameStarted = new Promise<void>((resolve) => {
      signalRename = resolve
    })
    fsCalls.waitAsync = (fn, target) => {
      if (fn !== 'rename' || !target.includes('orca-github-cache.json.')) {
        return null
      }
      signalRename()
      return renameRelease
    }
    fsCalls.dirPrefix = dir
    fsCalls.recording = true

    store.updateUI({ sidebarWidth: 611 })
    store.setGitHubCache({ pr: {}, issue: {} })
    const barrier = store.flushPendingOrThrowAsync()
    await renameStarted
    store.updateUI({ sidebarWidth: 612 })
    releaseRename()
    await barrier
    fsCalls.recording = false

    expect(JSON.parse(readFileSync(dataFile(dir), 'utf-8')).ui.sidebarWidth).toBe(612)
  })

  it('serializes a second writer behind the owned rotation', async () => {
    const dir = makeDir()
    const store = await createStore(dir)
    seedStaleBackup(dir)
    const almostDueSeconds = (Date.now() - (BACKUP_MIN_INTERVAL_MS - SAVE_DEBOUNCE_MS - 100)) / 1000
    utimesSync(`${dataFile(dir)}.bak.0`, almostDueSeconds, almostDueSeconds)
    const staleBackup = readFileSync(`${dataFile(dir)}.bak.0`, 'utf-8')
    const statCall = `stat:${dataFile(dir)}.bak.0`
    let releaseRotation!: () => void
    const rotationRelease = new Promise<void>((resolve) => {
      releaseRotation = resolve
    })
    let signalRotation!: () => void
    const rotationStarted = new Promise<void>((resolve) => {
      signalRotation = resolve
    })
    let held = false
    fsCalls.waitAsync = (fn, target) => {
      if (held || fn !== 'stat' || target !== `${dataFile(dir)}.bak.0`) {
        return null
      }
      held = true
      signalRotation()
      return rotationRelease
    }

    fsCalls.dirPrefix = dir
    fsCalls.recording = true
    store.updateUI({ sidebarWidth: 371 })
    vi.advanceTimersByTime(SAVE_DEBOUNCE_MS)
    const firstWrite = store.waitForPendingWrite()
    let allWrites = firstWrite
    try {
      await rotationStarted
      store.updateUI({ sidebarWidth: 372 })
      store.flushOrThrow()
      store.updateUI({ sidebarWidth: 373 })
      vi.advanceTimersByTime(SAVE_DEBOUNCE_MS)
      allWrites = store.waitForPendingWrite()
      expect(fsCalls.asyncCalls.filter((call) => call === statCall)).toHaveLength(1)
    } finally {
      releaseRotation()
      await allWrites
      fsCalls.recording = false
      fsCalls.waitAsync = null
    }
    const ring = ringSnapshot(dir)
    expect(JSON.parse(ring['orca-data.json']).ui.sidebarWidth).toBe(373)
    expect(JSON.parse(ring['orca-data.json.bak.0']).ui.sidebarWidth).toBe(372)
    expect(ring['orca-data.json.bak.1']).toBe(staleBackup)
    expect(ring['orca-data.json.bak.2']).toBeUndefined()
  })

  it.each(ROTATION_INTERLEAVE_CASES)(
    'keeps one rotation owner when a sync flush lands during %s',
    async (_phase, expectedFn, targetSuffix) => {
      const dir = makeDir()
      const store = await createStore(dir)
      seedStaleBackup(dir)
      const staleBackup = readFileSync(`${dataFile(dir)}.bak.0`, 'utf-8')
      const expectedTarget = `${dataFile(dir)}${targetSuffix}`

      store.updateUI({ sidebarWidth: 363 })
      fsCalls.dirPrefix = dir
      fsCalls.recording = true
      let flushed = false
      fsCalls.beforeAsync = (fn, target) => {
        if (flushed || fn !== expectedFn || target !== expectedTarget) {
          return
        }
        flushed = true
        store.updateUI({ sidebarWidth: 364 })
        store.flushOrThrow()
      }
      try {
        vi.advanceTimersByTime(PAST_ROTATION_INTERVAL_MS)
        await store.waitForPendingWrite()
      } finally {
        fsCalls.recording = false
        fsCalls.beforeAsync = null
      }

      expect(flushed).toBe(true)
      const ring = ringSnapshot(dir)
      expect(ring['orca-data.json.bak.0']).toBe(ring['orca-data.json'])
      expect(ring['orca-data.json.bak.1']).toBe(staleBackup)
      expect(ring['orca-data.json.bak.2']).toBeUndefined()
    }
  )

  it('does not log for absent ring slots even when the mount rejects renames non-ENOENT', async () => {
    // Probing keeps degraded mounts from logging one error per absent slot.
    const dir = makeDir()
    const store = await createStore(dir)
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    fsCalls.failAsync = (fn, target) =>
      fn === 'rename' && target.includes('.bak.')
        ? Object.assign(new Error('stale NFS file handle'), { code: 'ESTALE' })
        : null

    try {
      await recordAsyncSave(store, dir, 351)
      expect(errors).not.toHaveBeenCalled()
    } finally {
      errors.mockRestore()
    }
  })

  it('logs when a ring slot that exists fails to rotate', async () => {
    const dir = makeDir()
    const store = await createStore(dir)
    seedStaleBackup(dir)
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    fsCalls.failAsync = (fn, target) =>
      fn === 'rename' && target.endsWith('.bak.0')
        ? Object.assign(new Error('permission denied'), { code: 'EPERM' })
        : null

    try {
      await recordAsyncSave(store, dir, 352)
      expect(errors).toHaveBeenCalledWith(
        '[persistence] Failed to rotate backup',
        `${dataFile(dir)}.bak.0`,
        '->',
        `${dataFile(dir)}.bak.1`,
        expect.objectContaining({ code: 'EPERM' })
      )
    } finally {
      errors.mockRestore()
    }
  })

  it('produces a .bak ring byte-identical to the sync path, at capacity and with ring holes', async () => {
    const asyncDir = makeDir()
    const syncDir = makeDir()
    // Match generated IDs so only rotation behavior can differ.
    const seedDir = makeDir()
    const seedStore = await createStore(seedDir)
    seedStore.updateUI({ sidebarWidth: 320 })
    seedStore.flushOrThrow()
    const seed = readFileSync(dataFile(seedDir), 'utf-8')
    for (const dir of [asyncDir, syncDir]) {
      writeFileSync(dataFile(dir), seed, 'utf-8')
      // Holes: slots 1 and 3 occupied, 0 and 2 missing — exercises the per-slot existence branch.
      writeFileSync(`${dataFile(dir)}.bak.1`, '{"old":1}', 'utf-8')
      writeFileSync(`${dataFile(dir)}.bak.3`, '{"old":3}', 'utf-8')
    }

    const widths = [321, 322, 323, 324, 325, 326]
    const asyncStore = await createStore(asyncDir)
    for (const width of widths) {
      asyncStore.updateUI({ sidebarWidth: width })
      vi.advanceTimersByTime(PAST_ROTATION_INTERVAL_MS)
      await asyncStore.waitForPendingWrite()
    }

    const syncStore = await createStore(syncDir)
    for (const width of widths) {
      syncStore.updateUI({ sidebarWidth: width })
      syncStore.flushOrThrow()
      vi.advanceTimersByTime(PAST_ROTATION_INTERVAL_MS)
    }

    const ring = ringSnapshot(asyncDir)
    expect(ring).toEqual(ringSnapshot(syncDir))
    expect(Object.keys(ring)).toContain(`orca-data.json.bak.${BACKUP_COUNT - 1}`)
  })

  it('keeps the sync quit/crash fallback on synchronous syscalls', async () => {
    const dir = makeDir()
    const store = await createStore(dir)
    seedStaleBackup(dir)

    store.updateUI({ sidebarWidth: 331 })
    fsCalls.dirPrefix = dir
    fsCalls.recording = true
    try {
      store.flushOrThrow()
    } finally {
      fsCalls.recording = false
    }

    expect(fsCalls.syncCalls).toContain(`statSync:${dataFile(dir)}.bak.0`)
    expect(fsCalls.syncCalls).toContain(`existsSync:${dataFile(dir)}`)
    expect(fsCalls.asyncCalls).toEqual([])
  })
})
