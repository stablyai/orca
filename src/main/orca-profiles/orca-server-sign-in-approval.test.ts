import { describe, expect, it, vi } from 'vitest'
import { awaitServerSignInApproval } from './orca-server-sign-in-approval'
import {
  ServerSignInRequestRetryableError,
  type ServerSignInPollResult
} from './orca-cloud-server-sign-in-requests'

const CONFIG = { apiBaseUrl: 'https://login.example.test' }
const REDIRECT = 'https://login.example.test/v1/server-sign-in/verify?request=req-1'
const REQUEST = {
  requestId: 'req-1',
  claimToken: 'claim-secret',
  userCode: 'WDJB-MJHT',
  verificationUrl: 'https://login.example.test/device',
  intervalSeconds: 5,
  expiresInSeconds: 600
}

/** A fake clock the injected sleep advances, so no test waits in real time. */
function run(
  answers: (ServerSignInPollResult | Error)[],
  options: {
    signal?: AbortSignal
    isSuperseded?: () => boolean
    expiresInSeconds?: number
    /** Holds every sleep after the first until it resolves (or the signal aborts). */
    hold?: Promise<void>
    /** Runs while a poll is in flight, before its answer returns. */
    duringPoll?: (advanceClock: (ms: number) => void) => void
  } = {}
) {
  let clock = 0
  const sleeps: number[] = []
  const poll = vi.fn(async () => {
    options.duringPoll?.((ms) => {
      clock += ms
    })
    const next = answers.shift()
    if (!next) {
      throw new Error('polled after the test ran out of answers')
    }
    if (next instanceof Error) {
      throw next
    }
    return next
  })
  const result = awaitServerSignInApproval({
    config: CONFIG,
    request: { ...REQUEST, expiresInSeconds: options.expiresInSeconds ?? 600 },
    signal: options.signal ?? new AbortController().signal,
    isSuperseded: options.isSuperseded ?? (() => false),
    deps: {
      poll,
      now: () => clock,
      sleep: async (ms, signal) => {
        signal.throwIfAborted()
        if (options.hold && sleeps.length > 0) {
          await new Promise<void>((resolve, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason), { once: true })
            void options.hold?.then(resolve)
          })
        }
        sleeps.push(ms)
        clock += ms
      }
    }
  })
  return { result, poll, sleeps }
}

describe('awaitServerSignInApproval', () => {
  it('asks at the interval Orca Cloud set until the person approves', async () => {
    const { result, poll, sleeps } = run([
      { status: 'pending' },
      { status: 'pending' },
      { status: 'approved', code: 'one-time', redirectUri: REDIRECT }
    ])

    await expect(result).resolves.toEqual({ code: 'one-time', redirectUri: REDIRECT })
    expect(sleeps).toEqual([5_000, 5_000, 5_000])
    expect(poll).toHaveBeenCalledWith(
      CONFIG,
      expect.objectContaining({ claimToken: 'claim-secret' }),
      expect.anything()
    )
  })

  it('adds 5 seconds to the interval each time it is told to slow down, and keeps it', async () => {
    const { result, sleeps } = run([
      { status: 'slow_down' },
      { status: 'slow_down' },
      { status: 'pending' },
      { status: 'approved', code: 'one-time', redirectUri: REDIRECT }
    ])

    await expect(result).resolves.toEqual({ code: 'one-time', redirectUri: REDIRECT })
    expect(sleeps).toEqual([5_000, 10_000, 15_000, 15_000])
  })

  it('takes the slower interval Orca Cloud names in slow_down when it is longer than 5 more seconds', async () => {
    const { result, sleeps } = run([
      { status: 'slow_down', intervalSeconds: 20 },
      { status: 'slow_down', intervalSeconds: 10 },
      { status: 'approved', code: 'one-time', redirectUri: REDIRECT }
    ])

    await expect(result).resolves.toMatchObject({ code: 'one-time' })
    expect(sleeps).toEqual([5_000, 20_000, 25_000])
  })

  it('backs off on network trouble and 5xx answers, capped, then returns to the interval', async () => {
    const offline = () => new ServerSignInRequestRetryableError("Couldn't reach Orca Cloud.")
    const { result, sleeps } = run([
      offline(),
      offline(),
      offline(),
      offline(),
      { status: 'pending' },
      { status: 'approved', code: 'one-time', redirectUri: REDIRECT }
    ])

    await expect(result).resolves.toMatchObject({ code: 'one-time' })
    expect(sleeps).toEqual([5_000, 10_000, 20_000, 40_000, 60_000, 5_000])
  })

  it('stops on an answer it cannot retry', async () => {
    const { result } = run([new Error('Orca Cloud answered 400 while waiting for approval.')])

    await expect(result).rejects.toThrow('Orca Cloud answered 400')
  })

  it.each([
    ['denied', 'The sign-in was declined in the browser.'],
    ['expired', 'This sign-in expired. Start it again.']
  ] as const)('reports %s', async (status, message) => {
    const { result } = run([{ status: 'pending' }, { status }])

    await expect(result).rejects.toThrow(message)
  })

  it('gives up at the request’s expiry without asking past it', async () => {
    const { result, poll } = run(
      [{ status: 'pending' }, { status: 'pending' }, { status: 'pending' }],
      { expiresInSeconds: 12 }
    )

    await expect(result).rejects.toThrow('This sign-in expired. Start it again.')
    expect(poll).toHaveBeenCalledTimes(2)
  })

  it('stops asking once cancelled', async () => {
    const cancel = new AbortController()
    const { result, poll } = run([{ status: 'pending' }], {
      signal: cancel.signal,
      hold: new Promise(() => {})
    })
    await vi.waitFor(() => expect(poll).toHaveBeenCalled())

    cancel.abort()

    await expect(result).rejects.toThrow()
    expect(poll).toHaveBeenCalledTimes(1)
  })

  it('stops when a profile switch or another sign-in supersedes it', async () => {
    let superseded = false
    let release: () => void = () => {}
    const hold = new Promise<void>((resolve) => {
      release = resolve
    })
    const { result, poll } = run([{ status: 'pending' }], {
      isSuperseded: () => superseded,
      hold
    })
    await vi.waitFor(() => expect(poll).toHaveBeenCalled())

    superseded = true
    release()

    await expect(result).rejects.toThrow(
      'The account on this host changed during sign-in. Start again.'
    )
    expect(poll).toHaveBeenCalledTimes(1)
  })

  describe('drops an approval that comes back after the sign-in stopped wanting it', () => {
    const approved: ServerSignInPollResult = {
      status: 'approved',
      code: 'one-time',
      redirectUri: REDIRECT
    }

    it('after a cancel', async () => {
      const cancel = new AbortController()
      const { result } = run([approved], {
        signal: cancel.signal,
        duringPoll: () => cancel.abort()
      })

      await expect(result).rejects.toThrow()
    })

    it('after a sign-out or another sign-in', async () => {
      let superseded = false
      const { result } = run([approved], {
        isSuperseded: () => superseded,
        duringPoll: () => {
          superseded = true
        }
      })

      await expect(result).rejects.toThrow(
        'The account on this host changed during sign-in. Start again.'
      )
    })

    it('after its deadline', async () => {
      const { result } = run([approved], {
        expiresInSeconds: 10,
        duringPoll: (advanceClock) => advanceClock(10_000)
      })

      await expect(result).rejects.toThrow('This sign-in expired. Start it again.')
    })
  })
})
