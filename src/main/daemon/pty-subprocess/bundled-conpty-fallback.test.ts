import { afterEach, describe, expect, it, vi } from 'vitest'
import { spawnWithSystemConptyFallback } from './bundled-conpty-fallback'

const LAUNCH_FAILURE =
  'Cannot launch conpty: ConptyCreatePseudoConsole failed with HRESULT 0x80070005 using C:\\app\\conpty\\conpty.dll'

describe('spawnWithSystemConptyFallback', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('uses the bundled ConPTY when it starts', () => {
    const spawn = vi.fn((useConptyDll: boolean) => ({ useConptyDll }))
    expect(spawnWithSystemConptyFallback(spawn, 'pwsh.exe')).toEqual({ useConptyDll: true })
    expect(spawn).toHaveBeenCalledTimes(1)
  })

  it('retries once on the system ConPTY when the bundled one cannot launch', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const spawn = vi.fn((useConptyDll: boolean) => {
      if (useConptyDll) {
        throw new Error(LAUNCH_FAILURE)
      }
      return { useConptyDll }
    })
    expect(spawnWithSystemConptyFallback(spawn, 'pwsh.exe')).toEqual({ useConptyDll: false })
    expect(spawn.mock.calls).toEqual([[true], [false]])
    expect(warn.mock.calls[0]?.[0]).toContain('HRESULT 0x80070005')
  })

  it('reports both failures when the system ConPTY also fails', () => {
    const spawn = vi.fn((useConptyDll: boolean) => {
      throw new Error(
        useConptyDll ? LAUNCH_FAILURE : 'Cannot launch conpty: CreatePseudoConsole failed'
      )
    })
    expect(() => spawnWithSystemConptyFallback(spawn, 'pwsh.exe')).toThrow(
      `${LAUNCH_FAILURE}; system ConPTY fallback also failed: Cannot launch conpty: CreatePseudoConsole failed`
    )
    expect(spawn).toHaveBeenCalledTimes(2)
  })

  it('does not retry errors unrelated to the bundled ConPTY', () => {
    const spawn = vi.fn(() => {
      throw new Error('File not found: C:\\missing.exe')
    })
    expect(() => spawnWithSystemConptyFallback(spawn, 'missing.exe')).toThrow('File not found')
    expect(spawn).toHaveBeenCalledTimes(1)
  })
})
