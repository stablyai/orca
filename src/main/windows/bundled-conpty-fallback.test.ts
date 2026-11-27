import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IPty } from 'node-pty'
import type { spawnWithSystemConptyFallback as spawnWithFallbackType } from './bundled-conpty-fallback'
import type { conptySpawnStartedAtMs as spawnStartedAtType } from './conpty-spawn-time'

const LAUNCH_FAILURE =
  'Cannot launch conpty: ConptyCreatePseudoConsole failed with HRESULT 0x80070005 using C:\\app\\conpty\\conpty.dll'

let spawnWithSystemConptyFallback: typeof spawnWithFallbackType
let conptySpawnStartedAtMs: typeof spawnStartedAtType
const originalPlatform = process.platform

function fakePty(useConptyDll: boolean): IPty & { useConptyDll: boolean } {
  const noop = (): void => {}
  const event = (): { dispose: () => void } => ({ dispose: noop })
  return {
    useConptyDll,
    pid: 1,
    cols: 80,
    rows: 24,
    process: 'pwsh.exe',
    handleFlowControl: false,
    onData: event,
    onExit: event,
    resize: noop,
    clear: noop,
    write: noop,
    kill: noop,
    pause: noop,
    resume: noop
  }
}

describe('spawnWithSystemConptyFallback', () => {
  beforeEach(async () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    // Fresh module per test: the per-process memo must not leak between cases.
    vi.resetModules()
    ;({ spawnWithSystemConptyFallback } = await import('./bundled-conpty-fallback'))
    ;({ conptySpawnStartedAtMs } = await import('./conpty-spawn-time'))
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('uses the bundled ConPTY when it starts', () => {
    const spawn = vi.fn((useConptyDll: boolean) => fakePty(useConptyDll))
    expect(spawnWithSystemConptyFallback(spawn, 'pwsh.exe')).toMatchObject({ useConptyDll: true })
    expect(spawn).toHaveBeenCalledTimes(1)
  })

  it('falls back once, then goes straight to the system ConPTY and logs once', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const spawn = vi.fn((useConptyDll: boolean) => {
      if (useConptyDll) {
        throw new Error(LAUNCH_FAILURE)
      }
      return fakePty(useConptyDll)
    })
    const fallbackPty = spawnWithSystemConptyFallback(spawn, 'pwsh.exe')
    expect(fallbackPty).toMatchObject({ useConptyDll: false })
    expect(conptySpawnStartedAtMs(fallbackPty)).toBeTypeOf('number')
    expect(spawnWithSystemConptyFallback(spawn, 'cmd.exe')).toMatchObject({ useConptyDll: false })
    expect(spawn.mock.calls).toEqual([[true], [false], [false]])
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]?.[0]).toContain('HRESULT 0x80070005')
  })

  it('retries the bundled ConPTY after the spawn budget and clears the memo when it works', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { BUNDLED_CONPTY_RETRY_AFTER_SPAWNS } = await import('./bundled-conpty-fallback')
    let bundledBroken = true
    const spawn = vi.fn((useConptyDll: boolean) => {
      if (useConptyDll && bundledBroken) {
        throw new Error(LAUNCH_FAILURE)
      }
      return fakePty(useConptyDll)
    })
    spawnWithSystemConptyFallback(spawn, 'pwsh.exe')
    for (let i = 0; i < BUNDLED_CONPTY_RETRY_AFTER_SPAWNS; i++) {
      expect(spawnWithSystemConptyFallback(spawn, 'pwsh.exe')).toMatchObject({
        useConptyDll: false
      })
    }
    bundledBroken = false
    expect(spawnWithSystemConptyFallback(spawn, 'pwsh.exe')).toMatchObject({ useConptyDll: true })
    expect(spawnWithSystemConptyFallback(spawn, 'pwsh.exe')).toMatchObject({ useConptyDll: true })
  })

  it('retries the bundled ConPTY once the memo has aged out', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.useFakeTimers()
    const { BUNDLED_CONPTY_RETRY_AFTER_MS } = await import('./bundled-conpty-fallback')
    const spawn = vi.fn((useConptyDll: boolean) => {
      if (useConptyDll) {
        throw new Error(LAUNCH_FAILURE)
      }
      return fakePty(useConptyDll)
    })
    spawnWithSystemConptyFallback(spawn, 'pwsh.exe')
    vi.advanceTimersByTime(BUNDLED_CONPTY_RETRY_AFTER_MS)
    spawnWithSystemConptyFallback(spawn, 'pwsh.exe')
    expect(spawn.mock.calls).toEqual([[true], [false], [true], [false]])
  })

  it('reports both failures and keeps trying the bundled ConPTY when the system one also fails', () => {
    const spawn = vi.fn((useConptyDll: boolean) => {
      throw new Error(
        useConptyDll ? LAUNCH_FAILURE : 'Cannot launch conpty: CreatePseudoConsole failed'
      )
    })
    expect(() => spawnWithSystemConptyFallback(spawn, 'pwsh.exe')).toThrow(
      `${LAUNCH_FAILURE}; system ConPTY fallback also failed: Cannot launch conpty: CreatePseudoConsole failed`
    )
    expect(() => spawnWithSystemConptyFallback(spawn, 'pwsh.exe')).toThrow()
    expect(spawn.mock.calls).toEqual([[true], [false], [true], [false]])
  })

  it.each([
    'Cannot launch conpty: CreateNamedPipe(in) failed with HRESULT 0x800700E7 using C:\\conpty.dll',
    'File not found: C:\\missing.exe'
  ])('does not retry %s', (message) => {
    const spawn = vi.fn(() => {
      throw new Error(message)
    })
    expect(() => spawnWithSystemConptyFallback(spawn, 'pwsh.exe')).toThrow(message)
    expect(spawn).toHaveBeenCalledTimes(1)
  })

  it('spawns without the bundled DLL off Windows', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
    const spawn = vi.fn((useConptyDll: boolean) => fakePty(useConptyDll))
    expect(spawnWithSystemConptyFallback(spawn, '/bin/zsh')).toMatchObject({ useConptyDll: false })
  })
})
