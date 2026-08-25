import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  GIT_METADATA_FILESYSTEM_CONCURRENCY,
  GitMetadataPollScheduler,
  type GitMetadataPollSchedule,
  type GitMetadataWindowVisibility
} from './git-metadata-poll-scheduler'

function createVisibilityHarness(initiallyVisible = true): {
  visibility: GitMetadataWindowVisibility
  show: () => void
} {
  let visible = initiallyVisible
  const listeners = new Set<() => void>()
  return {
    visibility: {
      isWindowVisible: () => visible,
      onWindowBecameVisible: (listener) => {
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
        }
      }
    },
    show: () => {
      visible = true
      for (const listener of listeners) {
        listener()
      }
    }
  }
}

const alwaysVisible: GitMetadataWindowVisibility = {
  isWindowVisible: () => true,
  onWindowBecameVisible: () => () => {}
}
const fakeMonotonicNow = (): number => globalThis.performance.now()

describe('GitMetadataPollScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('stagger-starts 100 repos x 20 worktrees under one filesystem ceiling', async () => {
    const scheduler = new GitMetadataPollScheduler(
      GIT_METADATA_FILESYSTEM_CONCURRENCY,
      fakeMonotonicNow
    )
    const schedules: GitMetadataPollSchedule[] = []
    const pollStartedAt: number[] = []
    let activeFilesystemOperations = 0
    let peakFilesystemOperations = 0
    let completedFilesystemOperations = 0

    for (let repoIndex = 0; repoIndex < 100; repoIndex++) {
      schedules[repoIndex] = scheduler.schedule({
        key: `repo-${repoIndex}`,
        intervalMs: 2_000,
        visibility: alwaysVisible,
        run: async () => {
          pollStartedAt.push(Date.now())
          await Promise.all(
            Array.from({ length: 20 }, () =>
              scheduler.runFilesystemIo(async () => {
                activeFilesystemOperations++
                peakFilesystemOperations = Math.max(
                  peakFilesystemOperations,
                  activeFilesystemOperations
                )
                await Promise.resolve()
                activeFilesystemOperations--
                completedFilesystemOperations++
              })
            )
          )
          schedules[repoIndex].unsubscribe()
        }
      })
    }

    await vi.advanceTimersByTimeAsync(2_000)

    expect(completedFilesystemOperations).toBe(2_000)
    expect(peakFilesystemOperations).toBe(GIT_METADATA_FILESYSTEM_CONCURRENCY)
    expect(new Set(pollStartedAt).size).toBeGreaterThan(20)
    expect(Math.max(...pollStartedAt) - Math.min(...pollStartedAt)).toBeGreaterThan(1_000)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('coalesces many overdue intervals to one rerun without timer or queue growth', async () => {
    const scheduler = new GitMetadataPollScheduler(4, fakeMonotonicNow)
    const schedules: GitMetadataPollSchedule[] = []
    const runCounts = Array.from({ length: 100 }, () => 0)
    const { promise: firstRunGate, resolve: releaseFirstRuns } = Promise.withResolvers<void>()

    for (let index = 0; index < runCounts.length; index++) {
      schedules[index] = scheduler.schedule({
        key: `blocked-repo-${index}`,
        intervalMs: 100,
        visibility: alwaysVisible,
        run: async () => {
          runCounts[index]++
          if (runCounts[index] === 1) {
            await firstRunGate
            return
          }
          schedules[index].unsubscribe()
        }
      })
    }

    await vi.advanceTimersByTimeAsync(10_000)
    expect(runCounts.reduce((sum, count) => sum + count, 0)).toBe(4)
    expect(vi.getTimerCount()).toBe(1)

    releaseFirstRuns()
    await vi.runAllTimersAsync()

    expect(runCounts.every((count) => count === 2)).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps polling after the wall clock moves backward', async () => {
    const scheduler = new GitMetadataPollScheduler(
      GIT_METADATA_FILESYSTEM_CONCURRENCY,
      fakeMonotonicNow
    )
    let runs = 0
    const schedule = scheduler.schedule({
      key: 'clock-adjusted-repo',
      intervalMs: 100,
      visibility: alwaysVisible,
      run: () => {
        runs++
      }
    })

    await vi.advanceTimersByTimeAsync(100)
    expect(runs).toBe(1)

    vi.setSystemTime(-60_000)
    await vi.advanceTimersByTimeAsync(100)
    expect(runs).toBe(2)

    schedule.unsubscribe()
  })

  it('does zero hidden work and runs one immediate visibility catch-up', async () => {
    const scheduler = new GitMetadataPollScheduler(
      GIT_METADATA_FILESYSTEM_CONCURRENCY,
      fakeMonotonicNow
    )
    const visibility = createVisibilityHarness(false)
    const contexts: boolean[] = []
    const schedule = scheduler.schedule({
      key: 'hidden-repo',
      intervalMs: 2_000,
      visibility: visibility.visibility,
      run: ({ isVisibilityCatchUp }) => {
        contexts.push(isVisibilityCatchUp)
      }
    })

    await vi.advanceTimersByTimeAsync(60_000)
    expect(contexts).toEqual([])
    expect(vi.getTimerCount()).toBe(0)

    visibility.show()
    await vi.advanceTimersByTimeAsync(0)
    expect(contexts).toEqual([true])
    expect(vi.getTimerCount()).toBe(1)

    schedule.unsubscribe()
    expect(vi.getTimerCount()).toBe(0)
  })
})
