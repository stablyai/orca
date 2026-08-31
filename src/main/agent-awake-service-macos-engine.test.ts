import { describe, expect, it, vi } from 'vitest'
import { AgentAwakeService } from './agent-awake-service'
import type { AgentAwakeServiceOptions, AgentAwakeStatus } from './agent-awake-service'

vi.mock('electron', () => ({
  powerMonitor: { on: vi.fn(), off: vi.fn() },
  powerSaveBlocker: { start: vi.fn(), stop: vi.fn(), isStarted: vi.fn() }
}))

function workingStatus(): AgentAwakeStatus {
  return { state: 'working', receivedAt: 1_000, observedInCurrentRuntime: true }
}

function createBlocker() {
  const started = new Set<number>()
  let nextId = 1
  return {
    start: vi.fn(() => {
      const id = nextId++
      started.add(id)
      return id
    }),
    stop: vi.fn((id: number) => {
      started.delete(id)
    }),
    isStarted: vi.fn((id: number) => started.has(id))
  }
}

function createCaffeinate() {
  return { start: vi.fn(), stop: vi.fn(), dispose: vi.fn() }
}

function createAmphetamine(unavailable = false) {
  let active = false
  let pending = false
  let unavailableReason: 'not-installed' | 'automation-denied' | null = unavailable
    ? 'not-installed'
    : null
  const fake = {
    start: vi.fn(() => {
      if (!unavailableReason) {
        pending = true
      }
    }),
    settleObservation: (next = true) => {
      if (!pending) {
        return
      }
      pending = false
      active = next
    },
    stop: vi.fn(() => {
      active = false
      pending = false
    }),
    dispose: vi.fn(),
    isUnavailable: vi.fn(() => unavailableReason !== null),
    getUnavailableReason: vi.fn(() => unavailableReason),
    clearUnavailable: vi.fn(() => {
      unavailableReason = null
    }),
    isActive: vi.fn(() => active),
    setUnavailable: (reason: 'not-installed' | 'automation-denied' | null) => {
      unavailableReason = reason
    }
  }
  return fake
}

function createService(overrides: AgentAwakeServiceOptions = {}): {
  service: AgentAwakeService
  caffeinate: ReturnType<typeof createCaffeinate>
  amphetamine: ReturnType<typeof createAmphetamine>
} {
  const caffeinate = overrides.macosAssertion ?? createCaffeinate()
  const amphetamine = overrides.macosAmphetamineObserver ?? createAmphetamine()
  const service = new AgentAwakeService({
    blocker: createBlocker(),
    detectAmphetamine: async () => true,
    linuxAssertion: createCaffeinate(),
    logger: { debug: vi.fn(), warn: vi.fn() },
    macosAmphetamineObserver: amphetamine,
    macosAssertion: caffeinate,
    now: () => 1_000,
    platform: 'darwin',
    powerMonitor: null,
    ...overrides
  })
  return {
    service,
    caffeinate: caffeinate as ReturnType<typeof createCaffeinate>,
    amphetamine: amphetamine as ReturnType<typeof createAmphetamine>
  }
}

describe('AgentAwakeService macOS coverage', () => {
  it.each([
    ['caffeinate selected', 'caffeinate' as const, false],
    ['Amphetamine observation pending', 'amphetamine' as const, false],
    ['an active Amphetamine session observed', 'amphetamine' as const, true]
  ])('keeps caffeinate held with %s', (_label, engine, observedActive) => {
    const amphetamine = createAmphetamine()
    const caffeinate = createCaffeinate()
    const { service } = createService({
      macosAmphetamineObserver: amphetamine,
      macosAssertion: caffeinate
    })

    service.setMacosEngine(engine)
    service.setMode('on')
    if (observedActive) {
      amphetamine.settleObservation()
    }
    caffeinate.stop.mockClear()
    service.setStatuses([])

    expect(caffeinate.start).toHaveBeenCalled()
    expect(caffeinate.stop).not.toHaveBeenCalled()
  })

  it('still holds caffeinate when Amphetamine cannot be used at all', async () => {
    const amphetamine = createAmphetamine()
    const caffeinate = createCaffeinate()
    const { service } = createService({
      macosAmphetamineObserver: amphetamine,
      macosAssertion: caffeinate
    })

    service.setMacosEngine('amphetamine')
    await service.probeAmphetamine()
    amphetamine.setUnavailable('automation-denied')
    service.setMode('on')

    expect(caffeinate.start).toHaveBeenCalled()
    expect(amphetamine.start).not.toHaveBeenCalled()
  })

  it('stops both once Orca no longer wants the Mac awake', () => {
    const amphetamine = createAmphetamine()
    const caffeinate = createCaffeinate()
    const { service } = createService({
      macosAmphetamineObserver: amphetamine,
      macosAssertion: caffeinate
    })

    service.setMacosEngine('amphetamine')
    service.setMode('on')
    amphetamine.settleObservation()
    service.setMode('off')

    expect(caffeinate.stop).toHaveBeenCalled()
    expect(amphetamine.stop).toHaveBeenCalled()
  })
})

describe('AgentAwakeService macOS engine selection', () => {
  it('holds the session with caffeinate by default', () => {
    const { service, caffeinate, amphetamine } = createService()

    service.setMode('on')

    expect(caffeinate.start).toHaveBeenCalledTimes(1)
    expect(amphetamine.start).not.toHaveBeenCalled()
  })

  it('keeps caffeinate active when Amphetamine is unusable', async () => {
    const amphetamine = createAmphetamine()
    const { service, caffeinate } = createService({ macosAmphetamineObserver: amphetamine })

    service.setMacosEngine('amphetamine')
    await service.probeAmphetamine()
    amphetamine.setUnavailable('automation-denied')
    service.setMode('on')

    expect(amphetamine.start).not.toHaveBeenCalled()
    expect(caffeinate.start).toHaveBeenCalledTimes(1)
  })

  it('keeps a known install state when a later probe cannot tell', async () => {
    const amphetamine = createAmphetamine()
    const probe = vi.fn<() => Promise<boolean | undefined>>().mockResolvedValue(true)
    const { service } = createService({
      macosAmphetamineObserver: amphetamine,
      detectAmphetamine: probe
    })

    await service.probeAmphetamine()
    expect(service.getStatus().amphetamineInstalled).toBe(true)

    // A transient probe failure must not read as "the app went away".
    probe.mockResolvedValue(undefined)
    await expect(service.probeAmphetamine()).resolves.toBeUndefined()

    expect(service.getStatus().amphetamineInstalled).toBe(true)
  })

  it('reports an inconclusive explicit retry while retaining a known missing state', async () => {
    const probe = vi
      .fn<() => Promise<boolean | undefined>>()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(undefined)
    const { service } = createService({ detectAmphetamine: probe })

    await expect(service.probeAmphetamine()).resolves.toBe(false)
    await expect(service.probeAmphetamine()).resolves.toBeUndefined()

    expect(service.getStatus().amphetamineInstalled).toBe(false)
  })

  it('runs an unknown implicit installation probe only once', async () => {
    const probe = vi.fn<() => Promise<boolean | undefined>>().mockResolvedValue(undefined)
    const { service } = createService({ detectAmphetamine: probe })

    service.getStatus()
    service.getStatus()
    await vi.waitFor(() => expect(probe).toHaveBeenCalledOnce())
    service.getStatus()

    expect(probe).toHaveBeenCalledOnce()
    await service.probeAmphetamine()
    expect(probe).toHaveBeenCalledTimes(2)
  })

  it('does not queue a second implicit probe behind an explicit probe', async () => {
    let finish = (_installed: boolean | undefined): void => {}
    const probe = vi.fn(
      () =>
        new Promise<boolean | undefined>((resolve) => {
          finish = resolve
        })
    )
    const { service } = createService({ detectAmphetamine: probe })

    const explicit = service.probeAmphetamine()
    service.getStatus()
    service.getStatus()
    finish(true)
    await explicit

    expect(probe).toHaveBeenCalledOnce()
  })

  it('makes concurrent explicit callers await one queued fresh probe', async () => {
    const finishes: ((installed: boolean | undefined) => void)[] = []
    const probe = vi.fn(
      () =>
        new Promise<boolean | undefined>((resolve) => {
          finishes.push(resolve)
        })
    )
    const { service } = createService({ detectAmphetamine: probe })

    const first = service.probeAmphetamine()
    await vi.waitFor(() => expect(probe).toHaveBeenCalledOnce())
    const second = service.probeAmphetamine()
    const third = service.probeAmphetamine()
    finishes[0](false)
    await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(2))

    let secondSettled = false
    void second.then(() => {
      secondSettled = true
    })
    await Promise.resolve()
    expect(secondSettled).toBe(false)

    finishes[1](true)
    await expect(first).resolves.toBe(true)
    await expect(second).resolves.toBe(true)
    await expect(third).resolves.toBe(true)
    expect(probe).toHaveBeenCalledTimes(2)
    expect(service.getStatus().amphetamineInstalled).toBe(true)
  })

  it('clears a stale not-installed verdict when an explicit probe finds the app', async () => {
    const amphetamine = createAmphetamine()
    const probe = vi
      .fn<() => Promise<boolean | undefined>>()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true)
    const { service } = createService({
      detectAmphetamine: probe,
      macosAmphetamineObserver: amphetamine
    })

    service.setMacosEngine('amphetamine')
    await vi.waitFor(() => expect(service.getStatus().amphetamineInstalled).toBe(false))
    amphetamine.setUnavailable('not-installed')
    amphetamine.clearUnavailable.mockClear()
    service.setMode('on')
    amphetamine.start.mockClear()

    await service.probeAmphetamine()

    expect(amphetamine.clearUnavailable).toHaveBeenCalled()
    expect(amphetamine.start).toHaveBeenCalled()
  })

  it('does not clear Automation denial from an installation probe', async () => {
    const amphetamine = createAmphetamine()
    amphetamine.setUnavailable('automation-denied')
    const { service } = createService({ macosAmphetamineObserver: amphetamine })

    service.setMacosEngine('caffeinate')
    amphetamine.clearUnavailable.mockClear()

    await service.probeAmphetamine()

    expect(amphetamine.clearUnavailable).not.toHaveBeenCalled()
  })

  it('retries Automation observation only while Amphetamine remains selected', async () => {
    let resolveRetry = (_installed: boolean | undefined): void => {}
    const probe = vi
      .fn<() => Promise<boolean | undefined>>()
      .mockResolvedValueOnce(true)
      .mockImplementationOnce(
        () =>
          new Promise<boolean | undefined>((resolve) => {
            resolveRetry = resolve
          })
      )
    const amphetamine = createAmphetamine()
    const { service } = createService({
      detectAmphetamine: probe,
      macosAmphetamineObserver: amphetamine
    })

    service.setMacosEngine('amphetamine')
    await vi.waitFor(() => expect(service.getStatus().amphetamineInstalled).toBe(true))
    amphetamine.setUnavailable('automation-denied')
    amphetamine.clearUnavailable.mockClear()

    const retry = service.probeAmphetamine()
    service.setMacosEngine('caffeinate')
    resolveRetry(true)
    await retry

    expect(amphetamine.clearUnavailable).not.toHaveBeenCalled()
    expect(service.getStatus()).not.toHaveProperty('amphetamineUnavailableReason')
  })

  it('retries Automation observation in place when Amphetamine is still selected', async () => {
    const amphetamine = createAmphetamine()
    const { service } = createService({ macosAmphetamineObserver: amphetamine })

    service.setMacosEngine('amphetamine')
    await vi.waitFor(() => expect(service.getStatus().amphetamineInstalled).toBe(true))
    amphetamine.setUnavailable('automation-denied')
    amphetamine.clearUnavailable.mockClear()

    await expect(service.probeAmphetamine()).resolves.toBe(true)

    expect(amphetamine.clearUnavailable).toHaveBeenCalledOnce()
  })

  it('does not refresh disposed resources when an install probe resolves late', async () => {
    let resolveProbe = (_installed: boolean | undefined): void => {}
    const probe = vi.fn(
      () =>
        new Promise<boolean | undefined>((resolve) => {
          resolveProbe = resolve
        })
    )
    const { service, caffeinate, amphetamine } = createService({ detectAmphetamine: probe })

    service.setMode('on')
    const pendingProbe = service.probeAmphetamine()
    service.dispose()
    caffeinate.start.mockClear()
    amphetamine.start.mockClear()
    resolveProbe(true)
    await pendingProbe

    expect(caffeinate.start).not.toHaveBeenCalled()
    expect(amphetamine.start).not.toHaveBeenCalled()
  })

  it('aborts an in-flight installation probe on dispose', async () => {
    let probeSignal: AbortSignal | undefined
    const probe = vi.fn(
      (signal?: AbortSignal) =>
        new Promise<boolean | undefined>((resolve) => {
          probeSignal = signal
          signal?.addEventListener('abort', () => resolve(undefined), { once: true })
        })
    )
    const { service } = createService({ detectAmphetamine: probe })

    const pendingProbe = service.probeAmphetamine()
    service.dispose()

    expect(probeSignal?.aborted).toBe(true)
    await expect(pendingProbe).resolves.toBeUndefined()
  })

  it('retries a previously unusable engine when the user re-picks it', () => {
    const amphetamine = createAmphetamine(true)
    const { service } = createService({ macosAmphetamineObserver: amphetamine })

    service.setMacosEngine('amphetamine')
    amphetamine.clearUnavailable.mockClear()
    // Re-picking is the retry gesture after fixing a refused Automation grant.
    service.setMacosEngine('amphetamine')

    expect(amphetamine.clearUnavailable).toHaveBeenCalled()
  })

  it('publishes the engine and its availability to subscribers', async () => {
    const { service, amphetamine } = createService()
    const seen: unknown[] = []
    service.subscribe((status) => seen.push(status))

    await service.probeAmphetamine()
    service.setMacosEngine('amphetamine')
    service.setMode('auto')
    service.setStatuses([workingStatus()])
    amphetamine.settleObservation()
    service.setStatuses([workingStatus()])

    expect(service.getStatus()).toMatchObject({
      mode: 'auto',
      active: true,
      macosEngine: 'amphetamine',
      amphetamineInstalled: true,
      amphetamineActive: true
    })
    expect(seen.length).toBeGreaterThan(0)
  })

  it('omits macOS engine fields off macOS', () => {
    const { service } = createService({ platform: 'linux' })

    service.setMode('on')

    expect(service.getStatus()).toEqual({ mode: 'on', active: true })
  })

  it('disposes both integrations', () => {
    const { service, caffeinate, amphetamine } = createService()

    service.dispose()

    expect(caffeinate.dispose).toHaveBeenCalledTimes(1)
    expect(amphetamine.dispose).toHaveBeenCalledTimes(1)
  })
})
