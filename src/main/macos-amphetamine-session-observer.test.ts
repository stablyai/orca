import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  MACOS_AMPHETAMINE_OBSERVATION_RETRY_MS,
  MacosAmphetamineSessionObserver
} from './macos-amphetamine-session-observer'
import type { OsascriptResult } from './macos-amphetamine-session'

function ok(stdout = ''): OsascriptResult {
  return { code: 0, stdout, stderr: '', timedOut: false }
}

function failure(stderr: string, code = 1): OsascriptResult {
  return { code, stdout: '', stderr, timedOut: false }
}

function createFakeAmphetamine(initial: 'active' | 'inactive' = 'inactive') {
  let session = initial
  let writeCount = 0
  const run = vi.fn(async (script: string) => {
    if (/start new session|end session|allow |prevent |enable |disable /.test(script)) {
      writeCount += 1
      throw new Error('destructive Amphetamine script')
    }
    return ok(session)
  })
  return {
    run,
    reads: () => run.mock.calls.length,
    writes: () => writeCount,
    get session() {
      return session
    },
    setSession(next: 'active' | 'inactive') {
      session = next
    }
  }
}

function createObserver(
  amphetamine: ReturnType<typeof createFakeAmphetamine>,
  overrides: Record<string, unknown> = {}
): MacosAmphetamineSessionObserver {
  return new MacosAmphetamineSessionObserver({
    logger: { debug: vi.fn(), warn: vi.fn() },
    platform: 'darwin',
    reconcileMs: 0,
    runOsascript: amphetamine.run,
    ...overrides
  })
}

async function settle(): Promise<void> {
  for (let index = 0; index < 20; index += 1) {
    await Promise.resolve()
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('MacosAmphetamineSessionObserver safety boundary', () => {
  it('never starts a session when none is active', async () => {
    const amphetamine = createFakeAmphetamine()
    const observer = createObserver(amphetamine)

    observer.start('agents-working')
    await settle()

    expect(observer.isActive()).toBe(false)
    expect(amphetamine.writes()).toBe(0)
  })

  it('coalesces repeated starts into one observation', async () => {
    const amphetamine = createFakeAmphetamine('active')
    const observer = createObserver(amphetamine)

    observer.start('first-refresh')
    observer.start('second-refresh')
    observer.start('third-refresh')
    await settle()

    expect(amphetamine.reads()).toBe(1)
  })

  it('observes a same-shaped foreign session without inferring ownership', async () => {
    const amphetamine = createFakeAmphetamine('active')
    const observer = createObserver(amphetamine)

    observer.start('agents-working')
    await settle()
    observer.stop('agents-idle')

    expect(amphetamine.session).toBe('active')
    expect(amphetamine.writes()).toBe(0)
  })

  it('lets two Orca runtimes observe one session without either owning it', async () => {
    const amphetamine = createFakeAmphetamine('active')
    const first = createObserver(amphetamine)
    const second = createObserver(amphetamine)

    first.start('first-runtime')
    second.start('second-runtime')
    await settle()
    second.stop('second-runtime-idle')
    first.dispose()

    expect(amphetamine.session).toBe('active')
    expect(amphetamine.writes()).toBe(0)
  })

  it('leaves a replacement session untouched during periodic reconcile', async () => {
    vi.useFakeTimers()
    const amphetamine = createFakeAmphetamine('active')
    const observer = createObserver(amphetamine, { reconcileMs: 1_000 })

    observer.start('agents-working')
    await settle()
    amphetamine.setSession('active')
    await vi.advanceTimersByTimeAsync(1_000)
    await settle()

    expect(observer.isActive()).toBe(true)
    expect(amphetamine.writes()).toBe(0)
  })

  it('does not clean up a session across crash and restart', async () => {
    const amphetamine = createFakeAmphetamine('active')
    const beforeCrash = createObserver(amphetamine)

    beforeCrash.start('before-crash')
    await settle()
    beforeCrash.dispose()
    const afterRestart = createObserver(amphetamine)
    afterRestart.start('after-restart')
    await settle()

    expect(afterRestart.isActive()).toBe(true)
    expect(amphetamine.session).toBe('active')
    expect(amphetamine.writes()).toBe(0)
  })

  it('does not restore active state when stop wins an in-flight observation', async () => {
    const amphetamine = createFakeAmphetamine('active')
    let finish = (): void => {}
    amphetamine.run.mockImplementation(
      async () =>
        new Promise<OsascriptResult>((resolve) => {
          finish = () => resolve(ok('active'))
        })
    )
    const onStateChanged = vi.fn()
    const observer = createObserver(amphetamine, { onStateChanged })

    observer.start('agents-working')
    await settle()
    observer.stop('agents-idle')
    finish()
    await settle()

    expect(observer.isActive()).toBe(false)
    expect(onStateChanged).not.toHaveBeenCalled()
    expect(amphetamine.writes()).toBe(0)
  })

  it('fences a late observation after dispose', async () => {
    const amphetamine = createFakeAmphetamine('active')
    let finish = (): void => {}
    amphetamine.run.mockImplementation(
      async () =>
        new Promise<OsascriptResult>((resolve) => {
          finish = () => resolve(ok('active'))
        })
    )
    const onStateChanged = vi.fn()
    const observer = createObserver(amphetamine, { onStateChanged })

    observer.start('agents-working')
    await settle()
    observer.dispose()
    finish()
    await settle()

    expect(observer.isActive()).toBe(false)
    expect(onStateChanged).not.toHaveBeenCalled()
    expect(amphetamine.writes()).toBe(0)
  })

  it.each([
    ['unparseable output', async () => ok('unknown')],
    ['timeout', async () => ({ code: null, stdout: '', stderr: '', timedOut: true })],
    [
      'spawn rejection',
      async () => {
        throw new Error('spawn failed')
      }
    ]
  ])('never turns %s into cleanup authority', async (_label, run) => {
    const amphetamine = createFakeAmphetamine('active')
    amphetamine.run.mockImplementation(async () => run())
    const observer = createObserver(amphetamine)

    observer.start('agents-working')
    await settle()
    observer.stop('agents-idle')
    await settle()

    expect(observer.isActive()).toBe(false)
    expect(amphetamine.reads()).toBe(1)
    expect(amphetamine.writes()).toBe(0)
  })

  it('does nothing off macOS', async () => {
    const amphetamine = createFakeAmphetamine('active')
    const observer = createObserver(amphetamine, { platform: 'linux' })

    observer.start('agents-working')
    await settle()

    expect(amphetamine.reads()).toBe(0)
  })
})

describe('MacosAmphetamineSessionObserver reconciliation', () => {
  it('publishes inactive to active transitions on the periodic read', async () => {
    vi.useFakeTimers()
    const amphetamine = createFakeAmphetamine()
    const onStateChanged = vi.fn()
    const observer = createObserver(amphetamine, { onStateChanged, reconcileMs: 1_000 })

    observer.start('agents-working')
    await settle()
    amphetamine.setSession('active')
    await vi.advanceTimersByTimeAsync(1_000)
    await settle()

    expect(observer.isActive()).toBe(true)
    expect(onStateChanged).toHaveBeenCalledOnce()
  })

  it('publishes active to inactive transitions on the periodic read', async () => {
    vi.useFakeTimers()
    const amphetamine = createFakeAmphetamine('active')
    const onStateChanged = vi.fn()
    const observer = createObserver(amphetamine, { onStateChanged, reconcileMs: 1_000 })

    observer.start('agents-working')
    await settle()
    amphetamine.setSession('inactive')
    await vi.advanceTimersByTimeAsync(1_000)
    await settle()

    expect(observer.isActive()).toBe(false)
    expect(onStateChanged).toHaveBeenCalledTimes(2)
  })

  it('retries a transient read failure once its backoff expires', async () => {
    vi.useFakeTimers()
    const amphetamine = createFakeAmphetamine('active')
    amphetamine.run.mockResolvedValueOnce(failure('Apple event timed out'))
    const observer = createObserver(amphetamine, { now: Date.now, reconcileMs: 1_000 })

    observer.start('agents-working')
    await settle()
    expect(observer.isActive()).toBe(false)
    await vi.advanceTimersByTimeAsync(MACOS_AMPHETAMINE_OBSERVATION_RETRY_MS)
    await settle()

    expect(observer.isActive()).toBe(true)
    expect(amphetamine.reads()).toBe(2)
  })

  it('keeps a timed-out denial transient even when stderr contains its error code', async () => {
    vi.useFakeTimers()
    const amphetamine = createFakeAmphetamine('active')
    amphetamine.run.mockResolvedValueOnce({
      code: null,
      stdout: '',
      stderr: 'Not authorized to send Apple events to Amphetamine. (-1743)',
      timedOut: true
    })
    const observer = createObserver(amphetamine, { now: Date.now })

    observer.start('agents-working')
    await settle()
    expect(observer.getUnavailableReason()).toBeNull()
    await vi.advanceTimersByTimeAsync(MACOS_AMPHETAMINE_OBSERVATION_RETRY_MS)
    await settle()

    expect(observer.isActive()).toBe(true)
    expect(amphetamine.reads()).toBe(2)
  })

  it.each(['stop', 'dispose'] as const)('cancels periodic reads on %s', async (teardown) => {
    vi.useFakeTimers()
    const amphetamine = createFakeAmphetamine('active')
    const onStateChanged = vi.fn()
    const observer = createObserver(amphetamine, { onStateChanged, reconcileMs: 1_000 })

    observer.start('agents-working')
    await settle()
    if (teardown === 'stop') {
      observer.stop('teardown')
    } else {
      observer.dispose()
    }
    onStateChanged.mockClear()
    await vi.advanceTimersByTimeAsync(5_000)
    await settle()

    expect(amphetamine.reads()).toBe(1)
    expect(onStateChanged).not.toHaveBeenCalled()
  })

  it.each(['stop', 'dispose'] as const)('cancels transient retries on %s', async (teardown) => {
    vi.useFakeTimers()
    const amphetamine = createFakeAmphetamine('active')
    amphetamine.run.mockResolvedValueOnce(failure('Apple event timed out'))
    const onStateChanged = vi.fn()
    const observer = createObserver(amphetamine, { onStateChanged, reconcileMs: 1_000 })

    observer.start('agents-working')
    await settle()
    if (teardown === 'stop') {
      observer.stop('teardown')
    } else {
      observer.dispose()
    }
    onStateChanged.mockClear()
    await vi.advanceTimersByTimeAsync(MACOS_AMPHETAMINE_OBSERVATION_RETRY_MS * 2)
    await settle()

    expect(amphetamine.reads()).toBe(1)
    expect(onStateChanged).not.toHaveBeenCalled()
  })

  it('requires an explicit retry after Automation is denied', async () => {
    vi.useFakeTimers()
    const amphetamine = createFakeAmphetamine('active')
    amphetamine.run.mockResolvedValueOnce(
      failure('Not authorized to send Apple events to Amphetamine. (-1743)')
    )
    const observer = createObserver(amphetamine)

    observer.start('agents-working')
    await settle()
    await vi.advanceTimersByTimeAsync(MACOS_AMPHETAMINE_OBSERVATION_RETRY_MS * 3)
    await settle()
    expect(amphetamine.reads()).toBe(1)

    observer.clearUnavailable()
    observer.start('explicit-retry')
    await settle()

    expect(observer.isActive()).toBe(true)
    expect(amphetamine.reads()).toBe(2)
  })
})
