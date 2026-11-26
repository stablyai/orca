import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { spawnWithSystemConptyFallback as spawnWithFallbackType } from './bundled-conpty-fallback'

const LAUNCH_FAILURE =
  'Cannot launch conpty: ConptyCreatePseudoConsole failed with HRESULT 0x80070005 using C:\\app\\conpty\\conpty.dll'

let spawnWithSystemConptyFallback: typeof spawnWithFallbackType
const originalPlatform = process.platform

describe('spawnWithSystemConptyFallback', () => {
  beforeEach(async () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    // Fresh module per test: the per-process memo must not leak between cases.
    vi.resetModules()
    ;({ spawnWithSystemConptyFallback } = await import('./bundled-conpty-fallback'))
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
    vi.restoreAllMocks()
  })

  it('uses the bundled ConPTY when it starts', () => {
    const spawn = vi.fn((useConptyDll: boolean) => ({ useConptyDll }))
    expect(spawnWithSystemConptyFallback(spawn, 'pwsh.exe')).toEqual({ useConptyDll: true })
    expect(spawn).toHaveBeenCalledTimes(1)
  })

  it('falls back once, then goes straight to the system ConPTY and logs once', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const spawn = vi.fn((useConptyDll: boolean) => {
      if (useConptyDll) {
        throw new Error(LAUNCH_FAILURE)
      }
      return { useConptyDll }
    })
    expect(spawnWithSystemConptyFallback(spawn, 'pwsh.exe')).toEqual({ useConptyDll: false })
    expect(spawnWithSystemConptyFallback(spawn, 'cmd.exe')).toEqual({ useConptyDll: false })
    expect(spawn.mock.calls).toEqual([[true], [false], [false]])
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]?.[0]).toContain('HRESULT 0x80070005')
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
    const spawn = vi.fn((useConptyDll: boolean) => ({ useConptyDll }))
    expect(spawnWithSystemConptyFallback(spawn, '/bin/zsh')).toEqual({ useConptyDll: false })
  })
})
