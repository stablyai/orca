import { afterEach, expect, it, vi } from 'vitest'
import { OpenCodeDirGcLifecycle } from './overlay-dir-gc-lifecycle'

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

it('schedules one delayed sweep without holding the app open', async () => {
  vi.useFakeTimers()
  const timeout = vi.spyOn(globalThis, 'setTimeout')
  const lifecycle = new OpenCodeDirGcLifecycle(() => '/unused-test-root', 'unused-plugin.js')
  const run = vi.spyOn(lifecycle, 'run').mockResolvedValue({
    scanned: 0,
    removed: 0,
    failed: 0,
    keptReferenced: 0,
    keptYoung: 0,
    keptSourcePresent: 0,
    keptUnverifiable: 0
  })
  const inventory = vi.fn(async () => [])
  lifecycle.schedule(inventory)
  lifecycle.schedule(inventory)
  expect(timeout.mock.results[0]?.value.hasRef()).toBe(false)
  await vi.advanceTimersByTimeAsync(179999)
  expect(run).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1)
  expect(run).toHaveBeenCalledExactlyOnceWith(inventory)
})
