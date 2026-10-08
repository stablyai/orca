import type * as fs from 'node:fs'
import { statSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { pathRipgrepCommand, resetRelayRipgrepPathCacheForTests } from './relay-bundled-ripgrep'

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>()
  return { ...actual, statSync: vi.fn(actual.statSync) }
})

const originalPlatform = process.platform
const present = new Set<string>()
const statMock = vi.mocked(statSync)
const fileStats = statSync(new URL(import.meta.url))

describe('Windows relay ripgrep effective PATH cache', () => {
  beforeEach(() => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    vi.stubEnv('Path', undefined)
    vi.stubEnv('PATH', 'C:\\tools')
    vi.stubEnv('CARGO_HOME', 'C:\\cargo')
    vi.useFakeTimers()
    vi.setSystemTime(1000)
    present.clear()
    resetRelayRipgrepPathCacheForTests()
    statMock.mockImplementation((path) => {
      if (!present.has(String(path))) {
        throw Object.assign(new Error('missing'), { code: 'ENOENT' })
      }
      return fileStats
    })
    statMock.mockClear()
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
    vi.unstubAllEnvs()
    vi.useRealTimers()
    statMock.mockReset()
    resetRelayRipgrepPathCacheForTests()
  })

  it('finds rg in the Cargo fallback appended to the command environment', () => {
    present.add('C:\\cargo\\bin\\rg.exe')
    expect(pathRipgrepCommand()).toBe('C:\\cargo\\bin\\rg.exe')
    const calls = statMock.mock.calls.length
    expect(pathRipgrepCommand()).toBe('C:\\cargo\\bin\\rg.exe')
    expect(statMock).toHaveBeenCalledTimes(calls)
  })

  it('supports mixed-case Path and never probes cwd-relative entries', () => {
    vi.stubEnv('PATH', undefined)
    vi.stubEnv('Path', '.;node_modules\\.bin;\\tools;C:tools;C:\\safe')
    present.add('C:\\safe\\rg.exe')
    expect(pathRipgrepCommand()).toBe('C:\\safe\\rg.exe')
    expect(statMock.mock.calls.map(([path]) => path)).toEqual(['C:\\safe\\rg.exe'])
  })

  it('invalidates both successful and missing resolutions when effective PATH changes', () => {
    expect(pathRipgrepCommand()).toBeNull()
    vi.stubEnv('CARGO_HOME', 'D:\\cargo')
    present.add('D:\\cargo\\bin\\rg.exe')
    expect(pathRipgrepCommand()).toBe('D:\\cargo\\bin\\rg.exe')
    vi.stubEnv('PATH', 'E:\\tools')
    present.add('E:\\tools\\rg.exe')
    expect(pathRipgrepCommand()).toBe('E:\\tools\\rg.exe')
  })

  it('retries cached misses after a bounded delay without rescanning on each call', () => {
    expect(pathRipgrepCommand()).toBeNull()
    const calls = statMock.mock.calls.length
    present.add('C:\\tools\\rg.exe')
    vi.advanceTimersByTime(59_999)
    expect(pathRipgrepCommand()).toBeNull()
    expect(statMock).toHaveBeenCalledTimes(calls)
    vi.advanceTimersByTime(1)
    expect(pathRipgrepCommand()).toBe('C:\\tools\\rg.exe')
  })
})
