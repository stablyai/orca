import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrcadBundledRuntimeError } from './orcad-bundled-runtime'
import { resolveOrcadExitCode } from './orcad-exit-code'
import {
  guardSkippedPreflightImport,
  type SkippedPreflightGuardDeps
} from './orcad-skipped-preflight-guard'

function deps(overrides: Partial<SkippedPreflightGuardDeps> = {}): SkippedPreflightGuardDeps {
  return {
    skipped: () => true,
    reprobe: vi.fn(async () => {}),
    timeoutMs: 1_000,
    ...overrides
  }
}

const never = <T>(): Promise<T> => new Promise<T>(() => {})

afterEach(() => {
  vi.useRealTimers()
})

describe('profile import after a skipped preflight', () => {
  it('passes through untouched when the probe ran this start', async () => {
    const guard = deps({ skipped: () => false })
    await expect(guardSkippedPreflightImport(Promise.resolve('store'), guard)).resolves.toBe(
      'store'
    )
    expect(guard.reprobe).not.toHaveBeenCalled()
  })

  it('needs no probe when the import succeeds', async () => {
    const guard = deps()
    await expect(guardSkippedPreflightImport(Promise.resolve('store'), guard)).resolves.toBe(
      'store'
    )
    expect(guard.reprobe).not.toHaveBeenCalled()
  })

  it('re-probes a failed import and keeps its own error when the runtime is healthy', async () => {
    const guard = deps()
    const importError = new Error('database is locked')
    await expect(guardSkippedPreflightImport(Promise.reject(importError), guard)).rejects.toBe(
      importError
    )
    expect(guard.reprobe).toHaveBeenCalledOnce()
  })

  it('turns a failed import on a broken runtime into a configuration exit', async () => {
    const runtimeFault = new OrcadBundledRuntimeError('native module failed to load')
    const guard = deps({
      reprobe: vi.fn(async () => {
        throw runtimeFault
      })
    })
    const failure = await guardSkippedPreflightImport(
      Promise.reject(new Error('import failed')),
      guard
    ).catch((error: unknown) => error)
    expect(failure).toBe(runtimeFault)
    expect(resolveOrcadExitCode(failure)).toBe(78)
  })

  it('fails a hung import on a broken runtime within the guard, not the client’s timeout', async () => {
    vi.useFakeTimers()
    const runtimeFault = new OrcadBundledRuntimeError('SQLite hung')
    const guard = deps({
      reprobe: vi.fn(async () => {
        throw runtimeFault
      })
    })
    const pending = guardSkippedPreflightImport(never(), guard).catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(await pending).toBe(runtimeFault)
  })

  it('lets a slow import finish when the re-probe proves the runtime healthy', async () => {
    vi.useFakeTimers()
    let finish: (value: string) => void = () => {}
    const slow = new Promise<string>((resolve) => {
      finish = resolve
    })
    const guard = deps()
    const pending = guardSkippedPreflightImport(slow, guard)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(guard.reprobe).toHaveBeenCalledOnce()
    finish('store')
    await expect(pending).resolves.toBe('store')
  })
})
