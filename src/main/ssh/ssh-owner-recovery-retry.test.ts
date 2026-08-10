import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  PTY_CONSUMER_OWNER_HELD_ATTACHED_ERROR,
  PTY_CONSUMER_OWNER_HELD_DISCONNECTED_ERROR,
  PTY_CONSUMER_OWNER_HELD_SELF_ERROR,
  PTY_CONSUMER_OWNER_GRACE_MS,
  PTY_CONSUMER_OWNER_RECOVERY_PENDING_ERROR,
  PTY_CONSUMER_OWNER_RECOVERY_SUPERSEDED_ERROR,
  PtyConsumerSession
} from '../../shared/pty-consumer-session'
import {
  isSshOwnerAdmissionBlocked,
  retrySshOwnerRecoveryWhileBlocked,
  SSH_OWNER_HELD_DISCONNECTED_WAIT_MS,
  SSH_OWNER_HELD_SELF_WAIT_MS
} from './ssh-owner-recovery-retry'

function publicationPendingError(): Error & { code: number } {
  return Object.assign(new Error('Owner grant publication is still pending'), {
    code: PTY_CONSUMER_OWNER_RECOVERY_PENDING_ERROR
  })
}

function supersededError(): Error & { code: number } {
  return Object.assign(new Error('Owner recovery generation was superseded'), {
    code: PTY_CONSUMER_OWNER_RECOVERY_SUPERSEDED_ERROR
  })
}

function heldError(code: number): Error & { code: number } {
  return Object.assign(new Error('PTY session owner is held'), { code })
}

function openGate() {
  return {
    isCurrent: () => true,
    onClosed: () => () => {}
  }
}

describe('SSH owner recovery retry', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('recovers once the incumbent grant publication settles', async () => {
    vi.useFakeTimers()
    const attempt = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(publicationPendingError())
      .mockRejectedValueOnce(publicationPendingError())
      .mockResolvedValue('recovered')

    const recovery = retrySshOwnerRecoveryWhileBlocked(attempt, openGate())
    await vi.advanceTimersByTimeAsync(75)

    await expect(recovery).resolves.toBe('recovered')
    expect(attempt).toHaveBeenCalledTimes(3)
  })

  it('stops at the publication-settlement deadline', async () => {
    vi.useFakeTimers()
    const error = publicationPendingError()
    const attempt = vi.fn<() => Promise<never>>().mockRejectedValue(error)

    const recovery = retrySshOwnerRecoveryWhileBlocked(attempt, openGate(), 60)
    const rejection = expect(recovery).rejects.toBe(error)
    await vi.advanceTimersByTimeAsync(60)

    await rejection
    expect(attempt).toHaveBeenCalledTimes(3)
  })

  it('does not retry unrelated failures', async () => {
    const error = Object.assign(new Error('stale owner'), { code: -32041 })
    const attempt = vi.fn<() => Promise<never>>().mockRejectedValue(error)

    await expect(retrySshOwnerRecoveryWhileBlocked(attempt, openGate())).rejects.toBe(error)
    expect(attempt).toHaveBeenCalledOnce()
  })

  it('retries while a superseded transport is closing', async () => {
    vi.useFakeTimers()
    const attempt = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(supersededError())
      .mockResolvedValue('recovered')

    const recovery = retrySshOwnerRecoveryWhileBlocked(attempt, openGate())
    await vi.advanceTimersByTimeAsync(25)

    await expect(recovery).resolves.toBe('recovered')
    expect(attempt).toHaveBeenCalledTimes(2)
  })

  it('retries a disconnected holder until it releases admission', async () => {
    vi.useFakeTimers()
    const attempt = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(heldError(PTY_CONSUMER_OWNER_HELD_DISCONNECTED_ERROR))
      .mockRejectedValueOnce(heldError(PTY_CONSUMER_OWNER_HELD_DISCONNECTED_ERROR))
      .mockResolvedValue('recovered')

    const recovery = retrySshOwnerRecoveryWhileBlocked(attempt, openGate())
    await vi.advanceTimersByTimeAsync(75)

    await expect(recovery).resolves.toBe('recovered')
    expect(attempt).toHaveBeenCalledTimes(3)
  })

  it('never retries an attached holder', async () => {
    const error = heldError(PTY_CONSUMER_OWNER_HELD_ATTACHED_ERROR)
    const attempt = vi.fn<() => Promise<never>>().mockRejectedValue(error)

    // Why blocked, not transient: another connection is live on the claim, so no amount of waiting
    // inside this admission changes the answer.
    await expect(retrySshOwnerRecoveryWhileBlocked(attempt, openGate())).rejects.toBe(error)
    expect(attempt).toHaveBeenCalledOnce()
    expect(isSshOwnerAdmissionBlocked(error)).toBe(true)
    expect(isSshOwnerAdmissionBlocked(publicationPendingError())).toBe(false)
  })

  it('gives a disconnected holder its own budget rather than the publication one', async () => {
    vi.useFakeTimers()
    let failures = 0
    const attempt = vi.fn<() => Promise<string>>().mockImplementation(async () => {
      if (failures++ < 6) {
        throw heldError(PTY_CONSUMER_OWNER_HELD_DISCONNECTED_ERROR)
      }
      return 'recovered'
    })

    // Why a 60ms publication budget: six backoff waits run well past it, so a single shared deadline
    // would give up before the incumbent's clamped grace floor could ever elapse.
    const recovery = retrySshOwnerRecoveryWhileBlocked(attempt, openGate(), 60)
    await vi.advanceTimersByTimeAsync(SSH_OWNER_HELD_DISCONNECTED_WAIT_MS)

    await expect(recovery).resolves.toBe('recovered')
    expect(attempt).toHaveBeenCalledTimes(7)
  })

  it('reconnects on one relay channel after a local holder loses its resume proof', async () => {
    vi.useFakeTimers()
    const ownerSession = new PtyConsumerSession({
      serverBuildId: 'build-a',
      createLease: () => 'lease-a'
    })
    const hello = { clientInstanceId: 'client-a', requestedRole: 'session-owner' as const }
    const incumbent = ownerSession.admit(hello, {
      connectionId: 'relay-channel-1',
      principal: 'desktop',
      authenticated: true,
      allowSessionOwner: true
    })
    incumbent.commitPublication()
    ownerSession.close('relay-channel-1', 'local')

    const connectionIds = new Set<string>()
    const attempt = vi.fn(async () => {
      const connectionId = 'relay-channel-2'
      connectionIds.add(connectionId)
      const admission = ownerSession.admit(hello, {
        connectionId,
        principal: 'desktop',
        authenticated: true,
        allowSessionOwner: true
      })
      admission.commitPublication()
      return admission.grant
    })

    const recovery = retrySshOwnerRecoveryWhileBlocked(attempt, openGate())
    const result = recovery.then(
      (value) => ({ status: 'fulfilled' as const, value }),
      (error: unknown) => ({ status: 'rejected' as const, error })
    )
    await vi.advanceTimersByTimeAsync(SSH_OWNER_HELD_DISCONNECTED_WAIT_MS)

    await expect(result).resolves.toMatchObject({
      status: 'fulfilled',
      value: { resumed: false, ownerGeneration: 2 }
    })
    expect(connectionIds).toEqual(new Set(['relay-channel-2']))
    expect(attempt.mock.calls.length).toBeLessThanOrEqual(130)
    expect(SSH_OWNER_HELD_DISCONNECTED_WAIT_MS).toBe(PTY_CONSUMER_OWNER_GRACE_MS + 2_000)
  })

  it('cancels a full-grace owner wait when the relay channel closes', async () => {
    vi.useFakeTimers()
    const error = heldError(PTY_CONSUMER_OWNER_HELD_DISCONNECTED_ERROR)
    const attempt = vi.fn<() => Promise<never>>().mockRejectedValue(error)
    let current = true
    let close: (() => void) | undefined
    const recovery = retrySshOwnerRecoveryWhileBlocked(attempt, {
      isCurrent: () => current,
      onClosed: (listener) => {
        close = listener
        return () => {
          close = undefined
        }
      }
    })
    const rejection = expect(recovery).rejects.toBe(error)
    await vi.advanceTimersByTimeAsync(1_000)
    const attemptsBeforeClose = attempt.mock.calls.length

    current = false
    close?.()
    await rejection
    expect(close).toBeUndefined()

    await vi.advanceTimersByTimeAsync(SSH_OWNER_HELD_DISCONNECTED_WAIT_MS)
    expect(attempt).toHaveBeenCalledTimes(attemptsBeforeClose)
  })

  it('reports each exhausted retry budget under its own reason', async () => {
    vi.useFakeTimers()
    const exhausted: string[] = []
    const gate = { ...openGate(), onRetryExhausted: (reason: string) => exhausted.push(reason) }

    const pending = retrySshOwnerRecoveryWhileBlocked(
      vi.fn<() => Promise<never>>().mockRejectedValue(publicationPendingError()),
      gate,
      60
    )
    const pendingRejection = expect(pending).rejects.toThrow('publication')
    await vi.advanceTimersByTimeAsync(60)
    await pendingRejection

    const held = retrySshOwnerRecoveryWhileBlocked(
      vi
        .fn<() => Promise<never>>()
        .mockRejectedValue(heldError(PTY_CONSUMER_OWNER_HELD_DISCONNECTED_ERROR)),
      gate,
      60
    )
    const heldRejection = expect(held).rejects.toThrow('held')
    // Why the disconnected budget and not the 60ms one: each reason carries its own deadline so a
    // settling publication cannot spend the budget that waits out a grace floor.
    await vi.advanceTimersByTimeAsync(SSH_OWNER_HELD_DISCONNECTED_WAIT_MS)
    await heldRejection

    expect(exhausted).toEqual(['publication-pending', 'disconnected-holder'])
  })

  it('starts each budget when its own phase begins', async () => {
    vi.useFakeTimers()
    const start = Date.now()
    let disconnectedAttempts = 0
    const attempt = vi.fn<() => Promise<string>>().mockImplementation(async () => {
      // A publication that takes longer to settle than the whole disconnected budget.
      if (Date.now() - start < SSH_OWNER_HELD_DISCONNECTED_WAIT_MS + 100) {
        throw publicationPendingError()
      }
      return disconnectedAttempts++ < 3
        ? Promise.reject(heldError(PTY_CONSUMER_OWNER_HELD_DISCONNECTED_ERROR))
        : 'recovered'
    })

    const publicationBudget = SSH_OWNER_HELD_DISCONNECTED_WAIT_MS + 10_000
    const recovery = retrySshOwnerRecoveryWhileBlocked(attempt, openGate(), publicationBudget)
    await vi.advanceTimersByTimeAsync(publicationBudget)

    // Why this fails on eagerly computed deadlines: the disconnected budget would have started at
    // entry and be long gone by the time the first -32045 arrives, giving that phase zero attempts.
    await expect(recovery).resolves.toBe('recovered')
    expect(disconnectedAttempts).toBeGreaterThan(1)
  })

  it("treats the client's own attached connection as transient, not blocked", async () => {
    vi.useFakeTimers()
    const selfError = heldError(PTY_CONSUMER_OWNER_HELD_SELF_ERROR)
    const attempt = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(selfError)
      .mockResolvedValue('recovered')

    const recovery = retrySshOwnerRecoveryWhileBlocked(attempt, openGate())
    await vi.advanceTimersByTimeAsync(25)

    await expect(recovery).resolves.toBe('recovered')
    // Why not blocked: in a one-app deployment the incumbent is this client's own zombie, so parking
    // the target in 'error' with no retry strands the user until they restart the app.
    expect(isSshOwnerAdmissionBlocked(selfError)).toBe(false)
  })

  it('lets an exhausted self-holder fall through to ordinary reconnect backoff', async () => {
    vi.useFakeTimers()
    const selfError = heldError(PTY_CONSUMER_OWNER_HELD_SELF_ERROR)
    const attempt = vi.fn<() => Promise<never>>().mockRejectedValue(selfError)

    const recovery = retrySshOwnerRecoveryWhileBlocked(attempt, openGate())
    const rejection = expect(recovery).rejects.toBe(selfError)
    await vi.advanceTimersByTimeAsync(SSH_OWNER_HELD_SELF_WAIT_MS)
    await rejection

    // The error still surfaces, but unblocked — the relay-lost ladder retries it on backoff, which is
    // how this recovered before owner admission became explicit.
    expect(isSshOwnerAdmissionBlocked(selfError)).toBe(false)
  })

  it('stops waiting when the relay channel closes', async () => {
    vi.useFakeTimers()
    let current = true
    let close: (() => void) | undefined
    const error = publicationPendingError()
    const attempt = vi.fn<() => Promise<never>>().mockRejectedValue(error)
    const recovery = retrySshOwnerRecoveryWhileBlocked(attempt, {
      isCurrent: () => current,
      onClosed: (listener) => {
        close = listener
        return () => {
          close = undefined
        }
      }
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(close).toBeTypeOf('function')

    current = false
    close?.()

    await expect(recovery).rejects.toBe(error)
    expect(attempt).toHaveBeenCalledOnce()
  })
})
