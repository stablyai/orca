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
        // Count the call that blocks on the OS keyring.
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

  it('can skip the blocking probe for development profiles', () => {
    scheduleSecretProtectionGapReport({
      dataFile,
      log: (m) => void logged.push(m),
      deferUntilFirstWindow: true,
      skipInDevelopment: true
    })
    createWindow().reveal()
    drain()
    vi.advanceTimersByTime(20_000)
    expect(probes).toBe(0)
    expect(logged).toEqual([])
  })

  it('honors forced reports for development profiles', () => {
    scheduleSecretProtectionGapReport({
      dataFile,
      log: (m) => void logged.push(m),
      deferUntilFirstWindow: true,
      skipInDevelopment: true,
      force: true
    })
    createWindow().reveal()
    drain()
    expect(probes).toBe(1)
    expect(logged).toEqual(['[secrets] The OS keyring is unavailable.'])
  })

  /** Drain queued setImmediate callbacks; the 1ms is slack. */
  const drain = (): void => void vi.advanceTimersByTime(1)

  it('does not probe the keyring while the first window is still being created', () => {
    // A locked Linux keyring once delayed the first window by 76s (STA-5765).
    schedule()
    createWindow()
    // Drain the queue to catch probes scheduled before the first paint.
    drain()
    expect(probes).toBe(0)
    expect(logged).toEqual([])
  })

  it('probes once the window is ready to show', () => {
    schedule()
    const window = createWindow()
    window.reveal()
    // The reveal handler must return before the blocking probe.
    expect(probes).toBe(0)
    drain()
    expect(probes).toBe(1)
    expect(logged).toEqual(['[secrets] The OS keyring is unavailable.'])
  })

  it('still reports when ready-to-show never fires, so a failed reveal is not silent', () => {
    // GPU failures can prevent ready-to-show; serve has no window.
    schedule()
    createWindow()
    // Bracket the fallback deadline so an excessive delay cannot pass.
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
    // A once-guard could hide a fallback timer left armed after reveal.
    expect(vi.getTimerCount()).toBe(0)
    vi.runAllTimers()
    vi.advanceTimersByTime(60_000)
    vi.runAllTimers()
    expect(probes).toBe(1)
  })

  it('does not let the fallback timer hold the process open', () => {
    // A diagnostic timer must not keep a quitting app alive.
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
    // A late reveal after fallback must not trigger another blocking probe.
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
    // Deferred throws become fatal uncaught exceptions instead of promise rejections (#9441).
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
    // Serve must probe before advertising readiness to clients.
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
