import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: {} }))
vi.mock('../crash-reporting/durable-crash-breadcrumb', () => ({
  recordDurableCrashBreadcrumb: vi.fn()
}))

import {
  createRendererGpuStallWatchdog,
  RENDERER_GPU_STALL_MAX_KILLS,
  RENDERER_GPU_STALL_PING_INTERVAL_MS,
  RENDERER_GPU_STALL_TIMEOUT_MS
} from './renderer-gpu-stall-watchdog'

function createHarness(canPing: () => boolean = () => true) {
  let clock = 1_000
  let answer: (() => void) | null = null
  const deps = {
    pingRenderer: vi.fn(() => new Promise<void>((resolve) => (answer = resolve))),
    canPing: vi.fn(canPing),
    readRendererCpuSeconds: vi.fn((): number | null => 0),
    readGpuProcesses: vi.fn(() => [{ pid: 4242, creationTime: 1 }]),
    readGpuCrashTimes: vi.fn((): readonly number[] => [0]),
    killProcess: vi.fn(),
    onGpuKilled: vi.fn(),
    now: () => clock
  }
  const watchdog = createRendererGpuStallWatchdog(deps)
  const advance = (ms: number): void => {
    for (let elapsed = 0; elapsed < ms; elapsed += RENDERER_GPU_STALL_PING_INTERVAL_MS) {
      clock += RENDERER_GPU_STALL_PING_INTERVAL_MS
      watchdog.tick()
    }
  }
  const advanceAnswering = async (ms: number): Promise<void> => {
    for (let elapsed = 0; elapsed < ms; elapsed += RENDERER_GPU_STALL_PING_INTERVAL_MS) {
      clock += RENDERER_GPU_STALL_PING_INTERVAL_MS
      watchdog.tick()
      await Promise.resolve()
    }
  }
  const sleep = (ms: number): void => {
    clock += ms
    watchdog.tick()
  }
  return {
    deps,
    watchdog,
    advance,
    advanceAnswering,
    sleep,
    now: () => clock,
    answer: () => answer?.()
  }
}

describe('renderer GPU stall watchdog', () => {
  it('kills one qualified replacement after a GPU failure and an idle renderer stall', () => {
    const { deps, advance } = createHarness()
    advance(RENDERER_GPU_STALL_PING_INTERVAL_MS + RENDERER_GPU_STALL_TIMEOUT_MS)
    expect(deps.killProcess).toHaveBeenCalledWith(4242)
    expect(deps.onGpuKilled).toHaveBeenCalledTimes(1)
  })

  it('leaves the GPU alone while the renderer answers', async () => {
    const harness = createHarness()
    for (let round = 0; round < 10; round += 1) {
      harness.advance(RENDERER_GPU_STALL_PING_INTERVAL_MS)
      harness.answer()
      await Promise.resolve()
    }
    expect(harness.deps.pingRenderer.mock.calls.length).toBeGreaterThan(1)
    expect(harness.deps.killProcess).not.toHaveBeenCalled()
  })

  it('does not kill the GPU when the renderer is busy running JS', () => {
    const harness = createHarness()
    const { deps, advance } = harness
    deps.readRendererCpuSeconds.mockImplementation(() => harness.now() / 1_000)
    advance(RENDERER_GPU_STALL_TIMEOUT_MS * 3)
    expect(deps.killProcess).not.toHaveBeenCalled()
  })

  it('attempts only one recovery per window', () => {
    const { deps, advance } = createHarness()
    advance(RENDERER_GPU_STALL_TIMEOUT_MS * (RENDERER_GPU_STALL_MAX_KILLS + 3))
    expect(deps.killProcess).toHaveBeenCalledTimes(RENDERER_GPU_STALL_MAX_KILLS)
  })

  it('discards a ping that spanned an OS sleep', () => {
    const { deps, advance, sleep } = createHarness()
    advance(RENDERER_GPU_STALL_PING_INTERVAL_MS)
    sleep(RENDERER_GPU_STALL_TIMEOUT_MS * 10)
    advance(RENDERER_GPU_STALL_TIMEOUT_MS)
    expect(deps.killProcess).not.toHaveBeenCalled()
  })

  it('discards a ping while the renderer cannot be pinged', () => {
    let pingable = true
    const { deps, advance } = createHarness(() => pingable)
    advance(RENDERER_GPU_STALL_PING_INTERVAL_MS)
    pingable = false
    advance(RENDERER_GPU_STALL_TIMEOUT_MS * 2)
    pingable = true
    advance(RENDERER_GPU_STALL_TIMEOUT_MS)
    expect(deps.killProcess).not.toHaveBeenCalled()
  })
  it('drops a ping lost to a renderer reload instead of killing a healthy GPU', async () => {
    const { deps, watchdog, advance, advanceAnswering } = createHarness()
    advance(RENDERER_GPU_STALL_PING_INTERVAL_MS)
    // The reload orphans the pending ping; it never settles.
    watchdog.reset()
    deps.pingRenderer.mockImplementation(() => Promise.resolve())
    await advanceAnswering(RENDERER_GPU_STALL_TIMEOUT_MS * 4)
    expect(deps.killProcess).not.toHaveBeenCalled()
  })

  it('does not re-arm recovery after the one permitted kill', async () => {
    const { deps, advance, advanceAnswering } = createHarness()
    advance(RENDERER_GPU_STALL_TIMEOUT_MS)
    // The first ping is lost for good; the recovered renderer answers new ones.
    deps.pingRenderer.mockImplementation(() => Promise.resolve())
    await advanceAnswering(RENDERER_GPU_STALL_TIMEOUT_MS * 4)
    expect(deps.killProcess).toHaveBeenCalledTimes(1)
  })
  it.each([null, Number.NaN, Infinity])(
    'does not kill the GPU with unknown CPU usage (%s)',
    (cpu) => {
      const { deps, advance } = createHarness()
      deps.readRendererCpuSeconds.mockReturnValue(cpu)
      advance(RENDERER_GPU_STALL_TIMEOUT_MS * 3)
      expect(deps.killProcess).not.toHaveBeenCalled()
      expect(deps.pingRenderer).not.toHaveBeenCalled()
    }
  )

  it('does not kill a healthy GPU for a renderer stall without a GPU failure', () => {
    const { deps, advance } = createHarness()
    deps.readGpuCrashTimes.mockReturnValue([])
    advance(RENDERER_GPU_STALL_TIMEOUT_MS * 3)
    expect(deps.killProcess).not.toHaveBeenCalled()
  })

  it('leaves a natural GPU crash burst to the existing fallback', () => {
    const { deps, advance } = createHarness()
    deps.readGpuCrashTimes.mockReturnValue([0, 500])
    advance(RENDERER_GPU_STALL_TIMEOUT_MS * 3)
    expect(deps.killProcess).not.toHaveBeenCalled()
  })

  it('does not act on a GPU failure outside the existing crash window', () => {
    const { deps, sleep, advance } = createHarness()
    sleep(40_000)
    advance(RENDERER_GPU_STALL_TIMEOUT_MS * 3)
    expect(deps.killProcess).not.toHaveBeenCalled()
  })

  it('does not kill several GPU processes when ownership is ambiguous', () => {
    const { deps, advance } = createHarness()
    deps.readGpuProcesses.mockReturnValue([
      { pid: 4242, creationTime: 1 },
      { pid: 4243, creationTime: 1 }
    ])
    advance(RENDERER_GPU_STALL_TIMEOUT_MS * 3)
    expect(deps.killProcess).not.toHaveBeenCalled()
  })

  it('does not report success or repeat a failed kill attempt', () => {
    const { deps, advance } = createHarness()
    deps.killProcess.mockImplementation(() => {
      throw new Error('permission denied')
    })
    advance(RENDERER_GPU_STALL_TIMEOUT_MS * 3)
    expect(deps.killProcess).toHaveBeenCalledOnce()
    expect(deps.onGpuKilled).not.toHaveBeenCalled()
  })

  it('handles a ping that throws during renderer teardown', () => {
    const { deps, advance } = createHarness()
    deps.pingRenderer.mockImplementation(() => {
      throw new Error('Object has been destroyed')
    })
    expect(() => advance(RENDERER_GPU_STALL_TIMEOUT_MS * 3)).not.toThrow()
    expect(deps.killProcess).not.toHaveBeenCalled()
  })
  it.each([
    { pid: 0, creationTime: 1 },
    { pid: -1, creationTime: 1 },
    { pid: Number.NaN, creationTime: 1 },
    { pid: 4242, creationTime: 0 },
    { pid: 4242, creationTime: Number.NaN }
  ])(
    'does not ping or kill a process with an invalid identity ($pid, $creationTime)',
    (identity) => {
      const { deps, advance } = createHarness()
      deps.readGpuProcesses.mockReturnValue([identity])
      advance(RENDERER_GPU_STALL_TIMEOUT_MS * 3)
      expect(deps.pingRenderer).not.toHaveBeenCalled()
      expect(deps.killProcess).not.toHaveBeenCalled()
    }
  )

  it('does not inherit a timeout when a GPU PID is reused', () => {
    const { deps, advance } = createHarness()
    advance(RENDERER_GPU_STALL_PING_INTERVAL_MS)
    deps.readGpuProcesses.mockReturnValue([{ pid: 4242, creationTime: 2 }])
    advance(RENDERER_GPU_STALL_TIMEOUT_MS)
    expect(deps.killProcess).not.toHaveBeenCalled()
    advance(RENDERER_GPU_STALL_PING_INTERVAL_MS)
    expect(deps.killProcess).toHaveBeenCalledWith(4242)
  })
})
