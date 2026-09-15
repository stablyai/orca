import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { enableMainProcessCompileCache } from './native-code-cache'

describe('enableMainProcessCompileCache', () => {
  const originalEnv = process.env.NODE_COMPILE_CACHE

  beforeEach(() => {
    delete process.env.NODE_COMPILE_CACHE
  })

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.NODE_COMPILE_CACHE = originalEnv
    } else {
      delete process.env.NODE_COMPILE_CACHE
    }
    vi.restoreAllMocks()
  })

  it('enables compile cache and sets process.env.NODE_COMPILE_CACHE', () => {
    const result = enableMainProcessCompileCache(join(tmpdir(), 'orca-compile-cache-test'))
    expect(result.enabled).toBe(true)
    expect(result.directory).toBeTruthy()
    expect(process.env.NODE_COMPILE_CACHE).toBe(result.directory)
  })

  it('is idempotent: repeat calls keep reporting the enabled state without throwing', () => {
    const cacheDir = join(tmpdir(), 'orca-compile-cache-test')
    const first = enableMainProcessCompileCache(cacheDir)
    const second = enableMainProcessCompileCache(cacheDir)
    expect(first.enabled).toBe(true)
    // Node returns ALREADY_ENABLED with the original directory; the wrapper must
    // still report enabled so callers cannot mistake the state for a failure.
    expect(second.enabled).toBe(true)
    expect(second.directory).toBeTruthy()
  })

  it('exposes the runtime enable result shape for the build-banner fallback path', () => {
    // The build-time banner (electron.vite.config.ts) enables the cache before the
    // main graph evaluates; this module is the in-process fallback. Both must agree
    // on the contract: enabled + directory, never throw on a missing cache dir.
    const result = enableMainProcessCompileCache()
    expect(result.enabled).toBe(true)
    expect(typeof result.directory).toBe('string')
    expect(result.error).toBeUndefined()
  })
})
