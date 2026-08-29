import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { _resetSecretStoreForTests, setSecretStore } from '../../shared/secret-store'

type Listener = (...args: unknown[]) => void

const appListeners = new Map<string, Listener[]>()

vi.mock('electron', () => ({
  app: {
    once: (event: string, listener: Listener) => {
      const existing = appListeners.get(event) ?? []
      existing.push(listener)
      appListeners.set(event, existing)
    }
  }
}))

const { scheduleSecretProtectionGapReport } = await import('./deferred-secret-protection-report')

/** Stands in for the BrowserWindow the app creates first. */
function fakeWindow(): { once: (event: string, listener: Listener) => void; reveal: () => void } {
  const listeners: Listener[] = []
  return {
    once: (event, listener) => {
      if (event === 'ready-to-show') {
        listeners.push(listener)
      }
    },
    reveal: () => listeners.splice(0).forEach((listener) => listener())
  }
}

function createWindow(): ReturnType<typeof fakeWindow> {
  const window = fakeWindow()
  appListeners
    .get('browser-window-created')
    ?.splice(0)
    .forEach((listener) => listener({}, window))
  return window
}

describe('scheduleSecretProtectionGapReport', () => {
  let dir: string
  let dataFile: string
  let probes: number
  let logged: string[]

  beforeEach(() => {
    vi.useFakeTimers()
    appListeners.clear()
    dir = mkdtempSync(join(tmpdir(), 'orca-deferred-secret-report-'))
    dataFile = join(dir, 'orca-data.json')
    probes = 0
    logged = []
    setSecretStore({
      isEncryptionAvailable: () => true,
      encryptString: (plainText) => Buffer.from(plainText),
      decryptString: (cipher) => cipher.toString(),
      describeProtectionGap: () => {
        // Why count here: this is the call that blocks on the OS keyring.
        probes += 1
        return 'The OS keyring is unavailable.'
      }
    })
  })

  afterEach(() => {
    vi.useRealTimers()
    _resetSecretStoreForTests()
    rmSync(dir, { recursive: true, force: true })
  })

  const schedule = (): void =>
    scheduleSecretProtectionGapReport({
      dataFile,
      log: (m) => void logged.push(m),
      deferUntilFirstWindow: true
    })

  /** Runs an already-queued setImmediate; the 1ms is slack, not a delay under test. */
  const drain = (): void => void vi.advanceTimersByTime(1)

  it('does not probe the keyring while the first window is still being created', () => {
    // Why this is the regression: probing here blocked the window for 76s on a locked
    // Linux keyring, which reads to the user as "the app will not open" (STA-5765).
    schedule()
    createWindow()
    // Why drain: creation alone must arm nothing. Asserting before the queue drains
    // would also pass if the probe were merely queued off `browser-window-created`,
    // which on the real path still lands before the window paints.
    drain()
    expect(probes).toBe(0)
    expect(logged).toEqual([])
  })

  it('probes once the window is ready to show', () => {
    schedule()
    const window = createWindow()
    window.reveal()
    // Why: the reveal handler must return before the blocking probe runs, or the paint
    // it is waiting on is the thing being blocked.
    expect(probes).toBe(0)
    drain()
    expect(probes).toBe(1)
    expect(logged).toEqual(['[secrets] The OS keyring is unavailable.'])
  })

  it('still reports when ready-to-show never fires, so a failed reveal is not silent', () => {
    // Why: a GPU/driver failure can keep ready-to-show from ever firing, and headless
    // serve has no window at all.
    schedule()
    createWindow()
    // Why bracket the wait instead of running every timer: an unbounded flush passes for
    // any fallback delay, including one long enough to never arrive in a real session.
    vi.advanceTimersByTime(14_000)
    drain()
    expect(probes).toBe(0)
    vi.advanceTimersByTime(1_100)
    drain()
    expect(probes).toBe(1)
  })

  it('probes only once when the window reveals and the fallback also elapses', () => {
    schedule()
    const window = createWindow()
    window.reveal()
    drain()
    // Why assert the timer is gone and not just the probe count: the once-guard alone makes
    // the count right, so without this the fallback could stay armed for 15s past the reveal
    // and nothing here would notice.
    expect(vi.getTimerCount()).toBe(0)
    vi.runAllTimers()
    vi.advanceTimersByTime(60_000)
    vi.runAllTimers()
    expect(probes).toBe(1)
  })

  it('does not let the fallback timer hold the process open', () => {
    // Why: the report is diagnostics; a referenced 15s timer would keep a quitting app alive
    // for up to 15s after its last window closed.
    const timers: ReturnType<typeof setTimeout>[] = []
    const original = globalThis.setTimeout
    const spy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
      ...args: Parameters<typeof setTimeout>
    ) => {
      const timer = original(...args)
      timers.push(timer)
      return timer
    }) as typeof setTimeout)
    try {
      schedule()
    } finally {
      spy.mockRestore()
    }
    expect(timers).toHaveLength(1)
    expect(timers[0]?.hasRef()).toBe(false)
  })

  it('does not probe again when the window reveals after the fallback already reported', () => {
    // Why this order and not the reverse: a GPU that presents late reveals the window
    // after the fallback has already reported, and a second blocking keyring probe would
    // freeze the main thread exactly as the user starts interacting.
    schedule()
    const window = createWindow()
    vi.advanceTimersByTime(15_100)
    drain()
    expect(probes).toBe(1)
    window.reveal()
    drain()
    expect(probes).toBe(1)
  })

  it('does not turn a throwing report into a fatal main-process error', () => {
    // Why: deferred, this runs off whenReady's promise chain, where a throw is an
    // uncaughtException the main-process guard re-throws fatally (#9441) — not the
    // unhandled rejection the app survives. A diagnostic must never end the process.
    let thrown = 0
    scheduleSecretProtectionGapReport({
      dataFile,
      log: () => {
        thrown += 1
        throw new Error('log sink is broken')
      },
      deferUntilFirstWindow: true
    })
    const window = createWindow()
    window.reveal()
    expect(() => drain()).not.toThrow()
    expect(probes).toBe(1)
    expect(thrown).toBeGreaterThan(0)
  })

  it('reports inline in headless serve, before the runtime is advertised as ready', () => {
    // Why not deferred: serve opens no window, so the fallback would fire only after
    // clients could already have paired, and a frozen main thread reads as a dead host.
    scheduleSecretProtectionGapReport({
      dataFile,
      log: (m) => void logged.push(m),
      deferUntilFirstWindow: false
    })
    expect(probes).toBe(1)
    expect(logged).toEqual(['[secrets] The OS keyring is unavailable.'])
  })

  it('leaves no timer armed in headless serve', () => {
    scheduleSecretProtectionGapReport({
      dataFile,
      log: (m) => void logged.push(m),
      deferUntilFirstWindow: false
    })
    expect(vi.getTimerCount()).toBe(0)
    vi.runAllTimers()
    expect(probes).toBe(1)
  })
})
