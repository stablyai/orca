import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  PTY_CONSUMER_OWNER_GRACE_MS,
  PTY_CONSUMER_OWNER_HELD_DISCONNECTED_ERROR,
  PtyConsumerSession
} from '../../shared/pty-consumer-session'
import {
  retrySshOwnerRecoveryWhileBlocked,
  SSH_OWNER_HELD_DISCONNECTED_WAIT_MS
} from './ssh-owner-recovery-retry'

function heldError(): Error & { code: number } {
  return Object.assign(new Error('PTY session owner is held'), {
    code: PTY_CONSUMER_OWNER_HELD_DISCONNECTED_ERROR
  })
}

function ownerSession(
  clocks: { now?: () => number; monotonicNow?: () => number } = {}
): PtyConsumerSession {
  const session = new PtyConsumerSession({
    serverBuildId: 'relay-build',
    createLease: () => 'lease-a',
    ...clocks
  })
  const incumbent = session.admit(
    { clientInstanceId: 'client-a', requestedRole: 'session-owner' },
    {
      connectionId: 'relay-channel-1',
      principal: 'desktop',
      authenticated: true,
      allowSessionOwner: true
    }
  )
  incumbent.commitPublication()
  session.close('relay-channel-1', 'local')
  return session
}

function freshAdmission(session: PtyConsumerSession, connectionId: string) {
  return session.admit(
    { clientInstanceId: 'client-a', requestedRole: 'session-owner' },
    {
      connectionId,
      principal: 'desktop',
      authenticated: true,
      allowSessionOwner: true
    }
  )
}

function openGate() {
  return {
    isCurrent: () => true,
    onClosed: () => () => {}
  }
}

describe('SSH owner recovery authority', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it.each([
    ['forward', 60_000],
    ['backward', -60_000]
  ] as const)('keeps relay grace monotonic across a %s wall-clock step', (_label, stepMs) => {
    vi.useFakeTimers()
    const session = ownerSession()

    vi.advanceTimersByTime(1_000)
    const monotonicBeforeStep = performance.now()
    vi.setSystemTime(Date.now() + stepMs)
    expect(performance.now()).toBe(monotonicBeforeStep)
    vi.advanceTimersByTime(PTY_CONSUMER_OWNER_GRACE_MS - 1_001)

    expect(() => freshAdmission(session, 'relay-channel-2')).toThrow(
      expect.objectContaining({ code: PTY_CONSUMER_OWNER_HELD_DISCONNECTED_ERROR })
    )

    vi.advanceTimersByTime(1)
    expect(freshAdmission(session, 'relay-channel-3').grant).toMatchObject({
      ownerGeneration: 2,
      resumed: false
    })
  })

  it.each([
    ['forward', 60_000],
    ['backward', -60_000]
  ] as const)(
    'keeps the client budget independent of a %s wall-clock step through full relay grace',
    async (_label, stepMs) => {
      vi.useFakeTimers()
      let relayNow = 0
      const relayClock = () => relayNow
      // Both keys keep this byte-identical oracle runnable before and after the clock contract rename.
      const session = ownerSession({ now: relayClock, monotonicNow: relayClock })
      const attempt = vi.fn(async () => {
        const admission = freshAdmission(session, 'relay-channel-2')
        admission.commitPublication()
        return admission.grant
      })
      let outcome: 'pending' | 'fulfilled' | 'rejected' = 'pending'
      void retrySshOwnerRecoveryWhileBlocked(attempt, openGate()).then(
        () => {
          outcome = 'fulfilled'
        },
        () => {
          outcome = 'rejected'
        }
      )

      await vi.advanceTimersByTimeAsync(1_000)
      relayNow = 1_000
      vi.setSystemTime(Date.now() + stepMs)
      await vi.advanceTimersByTimeAsync(PTY_CONSUMER_OWNER_GRACE_MS - 1_001)
      relayNow = PTY_CONSUMER_OWNER_GRACE_MS - 1

      expect(outcome).toBe('pending')

      relayNow = PTY_CONSUMER_OWNER_GRACE_MS + 1
      await vi.advanceTimersByTimeAsync(250)
      expect(outcome).toBe('fulfilled')
    }
  )

  it('does not extend the client budget after a backward wall-clock step', async () => {
    vi.useFakeTimers()
    let outcome: 'pending' | 'rejected' = 'pending'
    void retrySshOwnerRecoveryWhileBlocked(
      vi.fn<() => Promise<never>>().mockRejectedValue(heldError()),
      openGate()
    ).then(undefined, () => {
      outcome = 'rejected'
    })

    await vi.advanceTimersByTimeAsync(1_000)
    vi.setSystemTime(Date.now() - 60_000)
    await vi.advanceTimersByTimeAsync(SSH_OWNER_HELD_DISCONNECTED_WAIT_MS - 1_000)

    expect(outcome).toBe('rejected')
  })

  it('revalidates relay authority after a refusal is delayed past the local deadline', async () => {
    vi.useFakeTimers()
    const staleRefusal = heldError()
    let attempts = 0
    const attempt = vi.fn(async () => {
      attempts += 1
      if (attempts === 1) {
        throw staleRefusal
      }
      if (attempts === 2) {
        await new Promise((resolve) =>
          setTimeout(resolve, SSH_OWNER_HELD_DISCONNECTED_WAIT_MS + 200)
        )
        throw staleRefusal
      }
      return 'authoritative-grant'
    })

    const recovery = retrySshOwnerRecoveryWhileBlocked(attempt, openGate())
    const result = recovery.then(
      (value) => ({ status: 'fulfilled' as const, value }),
      (error: unknown) => ({ status: 'rejected' as const, error })
    )
    await vi.advanceTimersByTimeAsync(SSH_OWNER_HELD_DISCONNECTED_WAIT_MS + 225)

    await expect(result).resolves.toEqual({
      status: 'fulfilled',
      value: 'authoritative-grant'
    })
    expect(attempt).toHaveBeenCalledTimes(3)
  })

  it('bounds a failed final authority probe and reports exhaustion once', async () => {
    vi.useFakeTimers()
    const exhausted: string[] = []
    const attempt = vi.fn<() => Promise<never>>().mockRejectedValue(heldError())
    const recovery = retrySshOwnerRecoveryWhileBlocked(attempt, {
      ...openGate(),
      onRetryExhausted: (reason) => exhausted.push(reason)
    })
    const rejection = expect(recovery).rejects.toMatchObject({
      code: PTY_CONSUMER_OWNER_HELD_DISCONNECTED_ERROR
    })

    await vi.advanceTimersByTimeAsync(SSH_OWNER_HELD_DISCONNECTED_WAIT_MS)

    await rejection
    expect(attempt.mock.calls.length).toBeLessThanOrEqual(133)
    expect(exhausted).toEqual(['disconnected-holder'])
  })

  it('does not probe again after cancellation and releases the close listener', async () => {
    vi.useFakeTimers()
    const staleRefusal = heldError()
    let current = true
    let closeListener: (() => void) | undefined
    let attempts = 0
    const attempt = vi.fn(async () => {
      attempts += 1
      if (attempts === 1) {
        throw staleRefusal
      }
      await new Promise((resolve) => setTimeout(resolve, SSH_OWNER_HELD_DISCONNECTED_WAIT_MS + 200))
      throw staleRefusal
    })
    const recovery = retrySshOwnerRecoveryWhileBlocked(attempt, {
      isCurrent: () => current,
      onClosed: (listener) => {
        closeListener = listener
        return () => {
          closeListener = undefined
        }
      }
    })
    const rejection = expect(recovery).rejects.toBe(staleRefusal)

    await vi.advanceTimersByTimeAsync(25)
    expect(closeListener).toBeUndefined()
    current = false
    await vi.advanceTimersByTimeAsync(SSH_OWNER_HELD_DISCONNECTED_WAIT_MS + 200)

    await rejection
    expect(attempt).toHaveBeenCalledTimes(2)
    expect(closeListener).toBeUndefined()
  })
})
