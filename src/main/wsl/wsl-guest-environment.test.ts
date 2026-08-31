import { getEventListeners } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const runProcessMock = vi.hoisted(() => vi.fn())
vi.mock('../../shared/child-process/run-process', () => ({ runProcess: runProcessMock }))
vi.mock('./wsl-executable-path', () => ({ resolveWslExecutablePath: () => 'wsl.exe' }))

import {
  getWslGuestEnvironment,
  invalidateWslGuestEnvironment,
  peekWslGuestEnvironment
} from './wsl-guest-environment'

/** Echo a well-formed payload back inside whatever fence the probe generated. */
function respondWithPayload(payload: string, code = 0): void {
  runProcessMock.mockImplementation(async (spec: { args: string[] }) => {
    const script = spec.args.at(-1) ?? ''
    const begin = /__ORCA_WSL_CAPTURE_BEGIN_[a-z0-9]+__/.exec(script)?.[0] ?? ''
    const end = /__ORCA_WSL_CAPTURE_END_[a-z0-9]+__/.exec(script)?.[0] ?? ''
    return {
      code,
      signal: null,
      stdout: `distro banner\n${begin}${payload}${end}`,
      stderr: '',
      timedOut: false
    }
  })
}

const GOOD = ['/home/u/.nvm/bin:/usr/bin', '/home/u', '/usr/bin/env'].join('\0')

beforeEach(() => {
  runProcessMock.mockReset()
  invalidateWslGuestEnvironment(undefined, true)
})
afterEach(() => invalidateWslGuestEnvironment(undefined, true))

describe('probing', () => {
  it('reads PATH, HOME and env out of a banner-polluted stdout', async () => {
    respondWithPayload(GOOD)
    expect(await getWslGuestEnvironment('Ubuntu')).toEqual({
      path: '/home/u/.nvm/bin:/usr/bin',
      home: '/home/u',
      envBinary: '/usr/bin/env'
    })
  })

  it('collapses a concurrent burst into one probe', async () => {
    // Teardown and detection both fan out; 32 login shells per burst is the
    // cost this cache exists to avoid.
    respondWithPayload(GOOD)
    await Promise.all(Array.from({ length: 32 }, () => getWslGuestEnvironment('Ubuntu')))
    expect(runProcessMock).toHaveBeenCalledTimes(1)
  })

  it('keeps distros isolated', async () => {
    respondWithPayload(GOOD)
    await getWslGuestEnvironment('Ubuntu')
    await getWslGuestEnvironment('Debian')
    expect(runProcessMock).toHaveBeenCalledTimes(2)
  })

  it('stops the cached wsl.exe probe when its only waiter is canceled', async () => {
    runProcessMock.mockImplementation(
      (spec: { signal: AbortSignal }) =>
        new Promise((resolve) => {
          spec.signal.addEventListener(
            'abort',
            () => resolve({ code: null, signal: null, stdout: '', stderr: '', timedOut: false }),
            { once: true }
          )
        })
    )
    const controller = new AbortController()
    const reason = new Error('refresh canceled')
    const operation = getWslGuestEnvironment('Ubuntu', 4_000, controller.signal)
    await vi.waitFor(() => expect(runProcessMock).toHaveBeenCalledOnce())

    controller.abort(reason)

    await expect(operation).rejects.toBe(reason)
    expect(runProcessMock.mock.calls[0]?.[0]?.signal.aborted).toBe(true)
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
  })

  it('keeps a shared probe alive while another waiter still needs it', async () => {
    let release!: (value: unknown) => void
    runProcessMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve
        })
    )
    const first = getWslGuestEnvironment('Ubuntu', 4_000)
    const controller = new AbortController()
    const reason = new Error('one refresh canceled')
    const canceled = getWslGuestEnvironment('Ubuntu', 4_000, controller.signal)
    controller.abort(reason)

    await expect(canceled).rejects.toBe(reason)
    expect(runProcessMock.mock.calls[0]?.[0]?.signal.aborted).toBe(false)
    release({ code: 0, signal: null, stdout: '', stderr: '', timedOut: false })
    await first
  })

  it('observes an abort that races between the initial check and listener registration', async () => {
    let release!: (value: unknown) => void
    runProcessMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve
        })
    )
    const first = getWslGuestEnvironment('Ubuntu', 4_000)
    await vi.waitFor(() => expect(runProcessMock).toHaveBeenCalledOnce())
    const reason = new Error('raced abort')
    const controller = new AbortController()
    const signal = {
      get aborted() {
        return controller.signal.aborted
      },
      get reason() {
        return controller.signal.reason
      },
      addEventListener: (
        type: string,
        listener: EventListenerOrEventListenerObject,
        options?: boolean | AddEventListenerOptions
      ) => {
        controller.abort(reason)
        controller.signal.addEventListener(type, listener, options)
      },
      removeEventListener: (
        type: string,
        listener: EventListenerOrEventListenerObject,
        options?: boolean | EventListenerOptions
      ) => controller.signal.removeEventListener(type, listener, options)
    } as unknown as AbortSignal

    await expect(getWslGuestEnvironment('Ubuntu', 1, signal)).rejects.toBe(reason)
    release({ code: 0, signal: null, stdout: '', stderr: '', timedOut: false })
    await first
  })

  it('starts a fresh probe immediately after the prior probe is canceled', async () => {
    let releaseCanceled!: (value: unknown) => void
    runProcessMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseCanceled = resolve
        })
    )
    const controller = new AbortController()
    const canceled = getWslGuestEnvironment('Ubuntu', 4_000, controller.signal)
    controller.abort(new Error('refresh canceled'))
    await expect(canceled).rejects.toThrow('refresh canceled')

    respondWithPayload(GOOD)
    await expect(getWslGuestEnvironment('Ubuntu', 4_000)).resolves.not.toBeNull()
    expect(runProcessMock).toHaveBeenCalledTimes(2)

    releaseCanceled({ code: null, signal: null, stdout: '', stderr: '', timedOut: false })
  })

  it('aborts a pending probe when its cache entry is invalidated', async () => {
    let probeSignal!: AbortSignal
    runProcessMock.mockImplementation(
      (spec: { signal: AbortSignal }) =>
        new Promise((resolve) => {
          probeSignal = spec.signal
          spec.signal.addEventListener(
            'abort',
            () => resolve({ code: null, signal: null, stdout: '', stderr: '', timedOut: false }),
            { once: true }
          )
        })
    )
    const operation = getWslGuestEnvironment('Ubuntu', 4_000)
    await vi.waitFor(() => expect(runProcessMock).toHaveBeenCalledOnce())

    invalidateWslGuestEnvironment('Ubuntu')

    expect(probeSignal.aborted).toBe(true)
    await expect(operation).resolves.toBeNull()
  })
})

describe('bad answers are not cached as good ones', () => {
  it.each([
    ['a relative HOME', ['/usr/bin', 'home/u', '/usr/bin/env'].join('\0')],
    ['a PATH with a newline', ['/usr/bin\nx', '/home/u', '/usr/bin/env'].join('\0')],
    ['a truncated payload', '/usr/bin'],
    ['a relative env binary', ['/usr/bin', '/home/u', 'env'].join('\0')]
  ])('rejects %s', async (_case, payload) => {
    respondWithPayload(payload)
    expect(await getWslGuestEnvironment('Ubuntu')).toBeNull()
    expect(peekWslGuestEnvironment('Ubuntu')).toBeUndefined()
  })

  it('treats a missing fence as a failed probe, not an empty PATH', async () => {
    runProcessMock.mockResolvedValue({
      code: 0,
      signal: null,
      stdout: 'only a banner, no fence',
      stderr: '',
      timedOut: false
    })
    expect(await getWslGuestEnvironment('Ubuntu')).toBeNull()
  })
})

describe('transient versus permanent failure', () => {
  it('does not retry a distro that cannot produce env', async () => {
    // 127 is the probe's own "no usable env". Retrying that forever turns a
    // probe into a poller.
    runProcessMock.mockResolvedValue({
      code: 127,
      signal: null,
      stdout: '',
      stderr: '',
      timedOut: false
    })
    await getWslGuestEnvironment('Ubuntu')
    await getWslGuestEnvironment('Ubuntu')
    expect(runProcessMock).toHaveBeenCalledTimes(1)
  })

  it('retries after the window when the probe timed out', async () => {
    vi.useFakeTimers()
    try {
      runProcessMock.mockResolvedValue({
        code: null,
        signal: null,
        stdout: '',
        stderr: '',
        timedOut: true
      })
      expect(await getWslGuestEnvironment('Ubuntu')).toBeNull()
      expect(await getWslGuestEnvironment('Ubuntu')).toBeNull()
      // Still one probe inside the window: the retry timer gates it now that
      // the in-flight entry is dropped.
      expect(runProcessMock).toHaveBeenCalledTimes(1)

      vi.setSystemTime(Date.now() + 6_000)
      respondWithPayload(GOOD)
      expect(await getWslGuestEnvironment('Ubuntu')).not.toBeNull()
      expect(runProcessMock).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('a failed verdict does not outlive its usefulness', () => {
  it('retries an unparseable payload rather than caching it forever', async () => {
    // Before: any unparseable payload was permanent, so one fence lost to a
    // truncated rc disabled every WSL feature on the distro until restart.
    vi.useFakeTimers()
    try {
      respondWithPayload('garbage')
      expect(await getWslGuestEnvironment('Ubuntu')).toBeNull()
      vi.setSystemTime(Date.now() + 6_000)
      respondWithPayload(GOOD)
      expect(await getWslGuestEnvironment('Ubuntu')).not.toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('lets a caller with more budget re-probe past a starved failure', async () => {
    // An optional 5s read must not hard-fail the 10s scan queued behind it.
    runProcessMock.mockResolvedValue({
      code: null,
      signal: null,
      stdout: '',
      stderr: '',
      timedOut: true
    })
    expect(await getWslGuestEnvironment('Ubuntu', 3_000)).toBeNull()
    respondWithPayload(GOOD)
    expect(await getWslGuestEnvironment('Ubuntu', 9_000)).not.toBeNull()
  })

  it("bounds a joiner by its own budget, not the starter's", async () => {
    // Joining used to mean waiting out the starter's probe, so a joiner could
    // reach its own command with 1ms left.
    let release: (v: unknown) => void = () => {}
    runProcessMock.mockImplementation(() => new Promise((r) => (release = r)))
    const slow = getWslGuestEnvironment('Ubuntu', 60_000)
    const joiner = getWslGuestEnvironment('Ubuntu', 30)
    expect(await joiner).toBeNull()
    release({ code: 0, signal: null, stdout: '', stderr: '', timedOut: false })
    await slow
  })
})

describe('invalidation', () => {
  it('re-probes after the caller invalidates, so a newly installed tool appears', async () => {
    // A user who installs nvm inside a running distro would otherwise keep the
    // pre-install PATH until Orca restarts, and read that as the detection bug
    // this cache exists to fix.
    respondWithPayload(GOOD)
    await getWslGuestEnvironment('Ubuntu')
    invalidateWslGuestEnvironment('Ubuntu')
    respondWithPayload(['/opt/new/bin', '/home/u', '/usr/bin/env'].join('\0'))
    expect((await getWslGuestEnvironment('Ubuntu'))?.path).toBe('/opt/new/bin')
  })
})
