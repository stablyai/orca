import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { ProcessResult, ProcessSpec } from '@orca/process-host/process-spec'
import {
  createSystemSleepHoldReader,
  parsePmsetSleepDisabled,
  SLEEP_DISABLED_CACHE_MS
} from './macos-sleep-disabled-setting'

function fixture(name: string): string {
  return readFileSync(join(__dirname, '__fixtures__', 'pmset-g', name), 'utf8')
}

const SLEEP_DISABLED_OUTPUT = fixture('macbook-sleep-disabled-1.txt')

function result(overrides: Partial<ProcessResult> = {}): ProcessResult {
  return { code: 0, signal: null, stdout: '', stderr: '', timedOut: false, ...overrides }
}

function silentLogger(): {
  debug: Mock<(...data: unknown[]) => void>
  warn: Mock<(...data: unknown[]) => void>
} {
  return {
    debug: vi.fn<(...data: unknown[]) => void>(),
    warn: vi.fn<(...data: unknown[]) => void>()
  }
}

describe('parsePmsetSleepDisabled', () => {
  it.each([
    ['macbook-sleep-disabled-1.txt', 'yes'],
    ['mac-mini-no-sleep-disabled-line.txt', 'no'],
    ['derived-sleep-disabled-0.txt', 'no'],
    ['empty.txt', 'unknown'],
    ['headerless-error.txt', 'unknown'],
    ['derived-no-system-section.txt', 'unknown'],
    ['derived-header-only.txt', 'unknown'],
    ['derived-duplicate-key.txt', 'unknown'],
    ['derived-value-2.txt', 'unknown'],
    ['hand-error-in-system-section.txt', 'unknown'],
    ['hand-sleep-disabled-in-current-section.txt', 'unknown'],
    ['hand-current-section-unknown-keys.txt', 'unknown']
  ] as const)('%s parses as %s', (name, expected) => {
    expect(parsePmsetSleepDisabled(fixture(name))).toBe(expected)
  })
})

describe('createSystemSleepHoldReader', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-22T06:00:00Z'))
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  function reader(
    run: (spec: ProcessSpec) => Promise<ProcessResult>,
    platform: NodeJS.Platform = 'darwin',
    logger = silentLogger()
  ): ReturnType<typeof createSystemSleepHoldReader> {
    return createSystemSleepHoldReader({ run, platform, logger })
  }

  it('asks pmset -g with a bounded timeout and output cap', async () => {
    const run = vi.fn().mockResolvedValue(result({ stdout: SLEEP_DISABLED_OUTPUT }))
    const hold = await reader(run).read()

    expect(hold.sleepDisabled).toBe('yes')
    expect(hold.observedAt).toBe(Date.now())
    expect(run).toHaveBeenCalledWith({
      program: '/usr/bin/pmset',
      args: ['-g'],
      timeoutMs: 2000,
      maxOutputBytes: 65536
    })
  })

  it.each([
    ['exit 1', () => Promise.resolve(result({ code: 1, stdout: SLEEP_DISABLED_OUTPUT }))],
    ['timeout', () => Promise.resolve(result({ code: null, timedOut: true }))],
    [
      'truncated output',
      () => Promise.resolve(result({ stdout: SLEEP_DISABLED_OUTPUT, outputTruncated: true }))
    ],
    ['spawn throw', () => Promise.reject(new Error('spawn ENOENT'))]
  ])('%s gives unknown', async (_name, run) => {
    expect((await reader(vi.fn(run)).read()).sleepDisabled).toBe('unknown')
  })

  it.each(['linux', 'win32'] as const)('%s gives unknown with zero spawns', async (platform) => {
    const run = vi.fn().mockResolvedValue(result({ stdout: SLEEP_DISABLED_OUTPUT }))
    const hold = await reader(run, platform).read()

    expect(hold.sleepDisabled).toBe('unknown')
    expect(run).not.toHaveBeenCalled()
  })

  it('shares one spawn across 20 concurrent and sequential reads, then re-spawns', async () => {
    const run = vi.fn().mockResolvedValue(result({ stdout: SLEEP_DISABLED_OUTPUT }))
    const sleepReader = reader(run)

    await Promise.all(Array.from({ length: 20 }, () => sleepReader.read()))
    await sleepReader.read()
    vi.advanceTimersByTime(SLEEP_DISABLED_CACHE_MS - 1)
    await sleepReader.read()
    expect(run).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(1)
    await sleepReader.read()
    expect(run).toHaveBeenCalledTimes(2)
    sleepReader.dispose()
  })

  it('stamps observedAt with the probe start and expires the cache from there', async () => {
    const started = Date.now()
    const run = vi
      .fn()
      .mockImplementation(
        () =>
          new Promise<ProcessResult>((resolve) =>
            setTimeout(() => resolve(result({ stdout: SLEEP_DISABLED_OUTPUT })), 1_500)
          )
      )
    const sleepReader = reader(run)

    const pending = sleepReader.read()
    await vi.advanceTimersByTimeAsync(1_500)
    expect((await pending).observedAt).toBe(started)

    await vi.advanceTimersByTimeAsync(SLEEP_DISABLED_CACHE_MS - 1_500 - 1)
    await sleepReader.read()
    expect(run).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(run).toHaveBeenCalledTimes(2)
    sleepReader.dispose()
  })

  it('retries after a failure once the cache window has passed', async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce(result({ code: 1 }))
      .mockResolvedValueOnce(result({ stdout: SLEEP_DISABLED_OUTPUT }))
    const sleepReader = reader(run)

    expect((await sleepReader.read()).sleepDisabled).toBe('unknown')
    expect((await sleepReader.read()).sleepDisabled).toBe('unknown')
    expect(run).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(SLEEP_DISABLED_CACHE_MS)

    expect((await sleepReader.read()).sleepDisabled).toBe('yes')
    expect(run).toHaveBeenCalledTimes(2)
    sleepReader.dispose()
  })

  it('releases the single-flight when the probe never settles', async () => {
    const run = vi
      .fn()
      .mockImplementationOnce(() => new Promise<ProcessResult>(() => {}))
      .mockResolvedValueOnce(result({ stdout: SLEEP_DISABLED_OUTPUT }))
    const sleepReader = reader(run)

    const stalled = sleepReader.read()
    await vi.advanceTimersByTimeAsync(4_500)
    expect((await stalled).sleepDisabled).toBe('unknown')

    await vi.advanceTimersByTimeAsync(SLEEP_DISABLED_CACHE_MS)
    expect((await sleepReader.read()).sleepDisabled).toBe('yes')
    expect(run).toHaveBeenCalledTimes(2)
    sleepReader.dispose()
  })

  it('warns once per failure streak and logs debug after that', async () => {
    const logger = silentLogger()
    const run = vi.fn().mockResolvedValue(result({ code: 1 }))
    const sleepReader = reader(run, 'darwin', logger)

    await sleepReader.read()
    vi.advanceTimersByTime(SLEEP_DISABLED_CACHE_MS)
    await sleepReader.read()

    expect(logger.warn).toHaveBeenCalledTimes(1)
    expect(logger.debug).toHaveBeenCalledTimes(1)
    sleepReader.dispose()
  })

  it('re-reads once at cache expiry so a stopped hold is seen within the bound', async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce(result({ stdout: SLEEP_DISABLED_OUTPUT }))
      .mockResolvedValue(result({ stdout: fixture('mac-mini-no-sleep-disabled-line.txt') }))
    const sleepReader = reader(run)

    const first = await sleepReader.read()
    expect(first.sleepDisabled).toBe('yes')
    await vi.advanceTimersByTimeAsync(1_000)
    expect((await sleepReader.read()).sleepDisabled).toBe('yes')
    expect(run).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(SLEEP_DISABLED_CACHE_MS - 1_000)
    expect(run).toHaveBeenCalledTimes(2)
    const refreshed = await sleepReader.read()
    expect(refreshed.sleepDisabled).toBe('no')
    expect(refreshed.observedAt - first.observedAt).toBeLessThanOrEqual(SLEEP_DISABLED_CACHE_MS)
    expect(run).toHaveBeenCalledTimes(2)
    sleepReader.dispose()
  })

  it('does not re-read at expiry once disposed', async () => {
    const run = vi.fn().mockResolvedValue(result({ stdout: SLEEP_DISABLED_OUTPUT }))
    const sleepReader = reader(run)

    await sleepReader.read()
    await sleepReader.read()
    sleepReader.dispose()
    await vi.advanceTimersByTimeAsync(SLEEP_DISABLED_CACHE_MS * 2)

    expect(run).toHaveBeenCalledTimes(1)
  })
})
