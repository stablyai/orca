// Regression cover for issue #10696: the debounced async save published state with
// `await renameDurable(...)` AFTER checking the write-generation guard. An await between the
// guard and the rename is not atomic, so a synchronous flushOrThrow() (quit / shutdown path)
// could publish fresher state during that await and then be silently clobbered when the stale
// rename landed last — losing every mutation the shutdown flush was there to save.
//
// The publication is now synchronous (renameDurableSync), which is the same shape
// active-view-preference.ts already uses for this exact hazard.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readdirSync, readFileSync, rmSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type * as DurableFileWrite from './durable-file-write'

const testState = { dir: '' }

// Counts which publication path the async save actually used, and lets a test suspend the
// async rename to recreate the pre-fix interleaving window.
const renameCalls = { async: 0, sync: 0 }
const renameHooks: {
  enteredAsyncRename: boolean
  onEnterAsyncRename: (() => void) | null
  gate: Promise<void> | null
} = { enteredAsyncRename: false, onEnterAsyncRename: null, gate: null }

vi.mock('./durable-file-write', async (importOriginal) => {
  const actual = await importOriginal<typeof DurableFileWrite>()
  return {
    ...actual,
    renameDurable: async (tmpPath: string, finalPath: string) => {
      renameCalls.async++
      renameHooks.enteredAsyncRename = true
      renameHooks.onEnterAsyncRename?.()
      if (renameHooks.gate) {
        await renameHooks.gate
      }
      await actual.renameDurable(tmpPath, finalPath)
    },
    renameDurableSync: (tmpPath: string, finalPath: string) => {
      renameCalls.sync++
      actual.renameDurableSync(tmpPath, finalPath)
    }
  }
})

vi.mock('./ssh/ssh-config-parser', () => ({
  loadUserSshConfig: vi.fn(),
  sshConfigHostsToTargets: vi.fn()
}))

vi.mock('electron', () => ({
  app: {
    getPath: () => testState.dir
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (plaintext: string) => Buffer.from(plaintext, 'utf-8'),
    decryptString: (ciphertext: Buffer) => ciphertext.toString('utf-8')
  }
}))

vi.mock('./telemetry/client', () => ({
  track: vi.fn()
}))

vi.mock('./telemetry/cohort-classifier', () => ({
  getCohortAtEmit: vi.fn().mockReturnValue({ nth_repo_added: 2 })
}))

async function createStore() {
  vi.resetModules()
  const { Store, initDataPath } = await import('./persistence')
  initDataPath()
  return new Store()
}

function dataFile(): string {
  return join(testState.dir, 'orca-data.json')
}

function persistedSidebarWidth(): number {
  const parsed = JSON.parse(readFileSync(dataFile(), 'utf-8')) as {
    ui: { sidebarWidth: number }
  }
  return parsed.ui.sidebarWidth
}

function leftoverTmpFiles(): string[] {
  return readdirSync(testState.dir).filter((name) => name.endsWith('.tmp'))
}

describe('persistence async write vs sync shutdown flush', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-clobber-'))
    renameCalls.async = 0
    renameCalls.sync = 0
    renameHooks.enteredAsyncRename = false
    renameHooks.onEnterAsyncRename = null
    renameHooks.gate = null
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it('publishes the debounced async save without an await between guard and rename', async () => {
    const store = await createStore()

    store.updateUI({ sidebarWidth: 321 })
    vi.advanceTimersByTime(1_000)
    await store.waitForPendingWrite()

    expect(persistedSidebarWidth()).toBe(321)
    // The publication must be the synchronous helper; an awaited rename reopens the #10696 window.
    expect(renameCalls.sync).toBeGreaterThan(0)
    expect(renameCalls.async).toBe(0)
  })

  it('does not let a stale async save clobber a newer sync shutdown flush', async () => {
    const store = await createStore()

    // Baseline so lastWrittenStateHash is populated, like a long-running session.
    store.updateUI({ sidebarWidth: 300 })
    vi.advanceTimersByTime(1_000)
    await store.waitForPendingWrite()
    expect(persistedSidebarWidth()).toBe(300)

    let releaseGate = (): void => {}
    renameHooks.gate = new Promise<void>((resolve) => {
      releaseGate = resolve
    })
    const enteredAsyncRename = new Promise<void>((resolve) => {
      renameHooks.onEnterAsyncRename = resolve
    })

    // Stale save in flight: this payload carries width 400.
    store.updateUI({ sidebarWidth: 400 })
    vi.advanceTimersByTime(1_000)
    const pendingAsyncWrite = store.waitForPendingWrite()

    // Pre-fix the async save parks inside the awaited rename, past its generation guard, which
    // is the window this test targets. Post-fix publication is synchronous, so the write simply
    // completes and there is no window to catch — race on both so the test is deterministic
    // either way.
    await Promise.race([enteredAsyncRename, pendingAsyncWrite])

    // Shutdown flush: newest state, published synchronously.
    store.updateUI({ sidebarWidth: 500 })
    store.flushOrThrow()
    expect(persistedSidebarWidth()).toBe(500)

    releaseGate()
    await pendingAsyncWrite

    // The newest state must survive; pre-fix the stale rename landed last and reverted it to 400.
    expect(persistedSidebarWidth()).toBe(500)
    expect(leftoverTmpFiles()).toEqual([])
  })

  it('leaves no orphan temp file when a shutdown flush wins the race outright', async () => {
    const store = await createStore()

    store.updateUI({ sidebarWidth: 300 })
    vi.advanceTimersByTime(1_000)
    await store.waitForPendingWrite()
    renameCalls.sync = 0
    renameCalls.async = 0

    // Timer fires, so an async save is queued, but it has not started reading state yet.
    store.updateUI({ sidebarWidth: 400 })
    vi.advanceTimersByTime(1_000)
    const pendingAsyncWrite = store.waitForPendingWrite()

    // Shutdown flush publishes newer state first; the queued async save must then find its work
    // already persisted, publish nothing, and leave no multi-MB temp file behind.
    store.updateUI({ sidebarWidth: 500 })
    store.flushOrThrow()
    await pendingAsyncWrite

    expect(persistedSidebarWidth()).toBe(500)
    expect(renameCalls.sync).toBe(0)
    expect(renameCalls.async).toBe(0)
    expect(leftoverTmpFiles()).toEqual([])
  })
})
