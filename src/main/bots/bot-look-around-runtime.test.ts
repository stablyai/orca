import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Store } from '../persistence/loading-store/store'
import { AutomationService } from '../automations/automation-service'

describe("Look around on the scheduler's tick", () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('ticks with the automation scheduler while it runs, and stops with it', () => {
    vi.useFakeTimers()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: start and stop read only the run and automation lists, which the stub returns empty.
    const store = { listAutomationRuns: () => [], listAutomations: () => [] } as unknown as Store
    const service = new AutomationService(store, { tickMs: 1_000 })
    const onTick = vi.fn()
    service.onTick = onTick

    service.start()
    vi.advanceTimersByTime(3_000)
    expect(onTick).toHaveBeenCalledTimes(3)
    service.stop()
    vi.advanceTimersByTime(3_000)
    expect(onTick).toHaveBeenCalledTimes(3)
  })
})
