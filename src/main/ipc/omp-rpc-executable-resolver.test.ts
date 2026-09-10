import { describe, expect, it, vi } from 'vitest'
import {
  createOmpExecutableResolver,
  type OmpExecutableResolverDeps
} from './omp-rpc-executable-resolver'

function makeDeps(overrides: Partial<OmpExecutableResolverDeps> = {}): OmpExecutableResolverDeps {
  return {
    isCommandOnPath: vi.fn(async () => false),
    hydrateShellPath: vi.fn(async () => {}),
    rehydrateShellPathForced: vi.fn(async () => {}),
    homedir: () => '/home/u',
    platform: 'darwin',
    canExecute: vi.fn(async () => false),
    ...overrides
  }
}

describe('createOmpExecutableResolver', () => {
  it('returns the bare command when already on PATH, without hydrating', async () => {
    const deps = makeDeps({ isCommandOnPath: vi.fn(async () => true) })
    const resolve = createOmpExecutableResolver(deps)
    expect(await resolve('omp')).toBe('omp')
    expect(deps.hydrateShellPath).not.toHaveBeenCalled()
  })

  it('returns the command after login-shell hydration reveals it', async () => {
    let hydrated = false
    const deps = makeDeps({
      isCommandOnPath: vi.fn(async () => hydrated),
      hydrateShellPath: vi.fn(async () => {
        hydrated = true
      })
    })
    const resolve = createOmpExecutableResolver(deps)
    expect(await resolve('omp')).toBe('omp')
    expect(deps.rehydrateShellPathForced).not.toHaveBeenCalled()
  })

  it('forces a re-hydration when the cached hydration produced nothing', async () => {
    let forced = false
    const deps = makeDeps({
      isCommandOnPath: vi.fn(async () => forced),
      rehydrateShellPathForced: vi.fn(async () => {
        forced = true
      })
    })
    const resolve = createOmpExecutableResolver(deps)
    expect(await resolve('omp')).toBe('omp')
    expect(deps.rehydrateShellPathForced).toHaveBeenCalledTimes(1)
  })

  it('falls back to well-known installer locations on posix', async () => {
    const deps = makeDeps({
      canExecute: vi.fn(async (candidate: string) => candidate === '/home/u/.local/bin/omp')
    })
    const resolve = createOmpExecutableResolver(deps)
    expect(await resolve('omp')).toBe('/home/u/.local/bin/omp')
  })

  it('never probes posix locations on win32', async () => {
    const canExecute = vi.fn(async () => true)
    const deps = makeDeps({ platform: 'win32', canExecute })
    const resolve = createOmpExecutableResolver(deps)
    expect(await resolve('omp')).toBeNull()
    expect(canExecute).not.toHaveBeenCalled()
  })

  it('returns the PATHEXT-resolved command shim on Windows', async () => {
    const resolve = createOmpExecutableResolver(
      makeDeps({
        platform: 'win32',
        resolveCommandOnPath: vi.fn(async () => 'C:\\Users\\u\\AppData\\Roaming\\npm\\omp.cmd')
      })
    )
    await expect(resolve('omp')).resolves.toBe('C:\\Users\\u\\AppData\\Roaming\\npm\\omp.cmd')
  })

  it('returns null when every strategy misses', async () => {
    const resolve = createOmpExecutableResolver(makeDeps())
    expect(await resolve('omp')).toBeNull()
  })

  it('runs hydration and forced re-hydration at most once across calls', async () => {
    const deps = makeDeps()
    const resolve = createOmpExecutableResolver(deps)
    await resolve('omp')
    await resolve('omp')
    expect(deps.hydrateShellPath).toHaveBeenCalledTimes(1)
    expect(deps.rehydrateShellPathForced).toHaveBeenCalledTimes(1)
  })
})
