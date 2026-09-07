import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  PTY_CONSUMER_OWNER_GRACE_MS,
  PTY_CONSUMER_SESSION_PROTOCOL_VERSION,
  type PtyConsumerSessionGrant
} from '../shared/pty-consumer-session'
import { SshPtySourceCreditAdapter } from './ssh-pty-source-credit-adapter'

function ownerGrant(
  clientGeneration: number,
  ownerGeneration: number
): Readonly<PtyConsumerSessionGrant> {
  return Object.freeze({
    protocolVersion: PTY_CONSUMER_SESSION_PROTOCOL_VERSION,
    serverBuildId: 'build-a',
    clientGeneration,
    role: 'session-owner',
    ownerGeneration,
    ownerLease: `lease-${ownerGeneration}`,
    capabilities: { outputFlowControl: { version: 1 as const, windowSu: 8 } }
  })
}

afterEach(() => vi.useRealTimers())

describe('SshPtySourceCreditAdapter cleanup', () => {
  it('grace expiry cancels old-owner tokens without closing a rotated replacement', () => {
    vi.useFakeTimers()
    const publishCancellation = vi.fn()
    const adapter = new SshPtySourceCreditAdapter(publishCancellation)
    const oldGrant = ownerGrant(1, 1)
    const replacementGrant = ownerGrant(2, 2)
    const rotated = adapter.open(oldGrant, 'pty-1', 'incarnation-1')!
    const expiring = adapter.open(oldGrant, 'pty-2', 'incarnation-2')!
    adapter.retainOrCloseOnDetach(oldGrant)

    const replacement = adapter.rotate(rotated, replacementGrant, 0).identity
    vi.advanceTimersByTime(PTY_CONSUMER_OWNER_GRACE_MS)

    expect(adapter.snapshot(expiring).state).toBe('closed')
    expect(adapter.snapshot(replacement).state).toBe('active')
    expect(publishCancellation).toHaveBeenCalledWith(
      expect.objectContaining({
        deliveryToken: expiring.deliveryToken,
        reason: 'reconnect-grace-expired',
        remainingStartSu: 0,
        remainingEndSu: 0
      })
    )
  })

  it('non-owner detach cleanup is exact to the client generation', () => {
    const adapter = new SshPtySourceCreditAdapter()
    const detached = adapter.open(ownerGrant(1, 1), 'pty-1', 'incarnation-1')!
    const active = adapter.open(ownerGrant(2, 2), 'pty-2', 'incarnation-2')!
    const subscriber: Readonly<PtyConsumerSessionGrant> = Object.freeze({
      protocolVersion: PTY_CONSUMER_SESSION_PROTOCOL_VERSION,
      serverBuildId: 'build-a',
      clientGeneration: 1,
      role: 'subscriber'
    })

    adapter.retainOrCloseOnDetach(subscriber)

    expect(adapter.snapshot(detached).state).toBe('closed')
    expect(adapter.snapshot(active).state).toBe('active')
  })

  it('prunes tokens across many normal sealed exits', () => {
    const adapter = new SshPtySourceCreditAdapter()
    const grant = ownerGrant(1, 1)

    for (let index = 0; index < 300; index++) {
      const identity = adapter.open(grant, `pty-${index}`, `incarnation-${index}`)!
      adapter.seal(identity)
      adapter.settleExit(identity, { ok: true })
    }

    expect(adapter.retentionSnapshot()).toEqual({
      deliveryTokens: 0,
      graceTimers: 0,
      sourceSu: 0,
      dataBytes: 0,
      spans: 0
    })
  })

  it('disposes grace timers and exact retained tokens', () => {
    vi.useFakeTimers()
    const adapter = new SshPtySourceCreditAdapter()
    const grant = ownerGrant(1, 1)
    const first = adapter.open(grant, 'pty-1', 'incarnation-1')!
    const second = adapter.open(grant, 'pty-2', 'incarnation-2')!
    adapter.retainOrCloseOnDetach(grant)
    expect(adapter.retentionSnapshot()).toEqual({
      deliveryTokens: 2,
      graceTimers: 1,
      sourceSu: 0,
      dataBytes: 0,
      spans: 0
    })

    adapter.dispose()

    expect(adapter.retentionSnapshot()).toEqual({
      deliveryTokens: 0,
      graceTimers: 0,
      sourceSu: 0,
      dataBytes: 0,
      spans: 0
    })
    expect(adapter.snapshot(first)).toMatchObject({ state: 'closed', generationClosed: true })
    expect(adapter.snapshot(second)).toMatchObject({ state: 'closed', generationClosed: true })
    expect(() => adapter.open(grant, 'pty-late', 'incarnation-late')).toThrow('disposed')
  })

  it('notifies credit availability on every adapter-side cancellation but not on rotate', () => {
    vi.useFakeTimers()
    const onCreditAvailable = vi.fn()
    const adapter = new SshPtySourceCreditAdapter(undefined, onCreditAvailable)
    const grant = ownerGrant(1, 1)
    const canceled = adapter.open(grant, 'pty-cancel', 'incarnation-1')!

    adapter.cancel(
      {
        id: canceled.id,
        deliveryToken: canceled.deliveryToken,
        clientGeneration: canceled.clientGeneration,
        ownerGeneration: canceled.ownerGeneration
      },
      grant
    )
    expect(onCreditAvailable.mock.calls).toEqual([['pty-cancel']])

    const expiring = adapter.open(grant, 'pty-grace', 'incarnation-2')!
    adapter.retainOrCloseOnDetach(grant)
    vi.advanceTimersByTime(PTY_CONSUMER_OWNER_GRACE_MS)
    expect(onCreditAvailable.mock.calls).toEqual([['pty-cancel'], ['pty-grace']])
    expect(adapter.snapshot(expiring).state).toBe('closed')

    const detaching = adapter.open(ownerGrant(3, 3), 'pty-detach', 'incarnation-3')!
    adapter.retainOrCloseOnDetach(
      Object.freeze({
        protocolVersion: PTY_CONSUMER_SESSION_PROTOCOL_VERSION,
        serverBuildId: 'build-a',
        clientGeneration: 3,
        role: 'subscriber'
      })
    )
    expect(onCreditAvailable.mock.calls).toEqual([['pty-cancel'], ['pty-grace'], ['pty-detach']])
    expect(adapter.snapshot(detaching).state).toBe('closed')

    const rotating = adapter.open(ownerGrant(4, 4), 'pty-rotate', 'incarnation-4')!
    adapter.rotate(rotating, ownerGrant(5, 5), 0)
    const publicationOwned = adapter.open(ownerGrant(6, 6), 'pty-publication', 'incarnation-5')!
    adapter.cancelIdentity(publicationOwned, 'publication-owned')
    expect(onCreditAvailable).toHaveBeenCalledTimes(3)
    expect(adapter.snapshot(publicationOwned).state).toBe('closed')
  })

  it('swallows a throwing credit-available callback in cancel and in the grace timer', () => {
    vi.useFakeTimers()
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    try {
      const adapter = new SshPtySourceCreditAdapter(undefined, () => {
        throw new Error('publication faulted')
      })
      const grant = ownerGrant(1, 1)
      const canceled = adapter.open(grant, 'pty-1', 'incarnation-1')!

      expect(() =>
        adapter.cancel(
          {
            id: canceled.id,
            deliveryToken: canceled.deliveryToken,
            clientGeneration: canceled.clientGeneration,
            ownerGeneration: canceled.ownerGeneration
          },
          grant
        )
      ).not.toThrow()

      const expiring = adapter.open(grant, 'pty-2', 'incarnation-2')!
      adapter.retainOrCloseOnDetach(grant)
      expect(() => vi.advanceTimersByTime(PTY_CONSUMER_OWNER_GRACE_MS)).not.toThrow()

      expect(adapter.snapshot(expiring).state).toBe('closed')
      expect(stderr.mock.calls.map(([line]) => String(line))).toEqual([
        expect.stringContaining(
          '[pty-source-credit] credit-available notification failed for pty-1'
        ),
        expect.stringContaining(
          '[pty-source-credit] credit-available notification failed for pty-2'
        )
      ])
    } finally {
      stderr.mockRestore()
    }
  })

  it('returns the same bounded proof for duplicate token cancellation', () => {
    const adapter = new SshPtySourceCreditAdapter()
    const grant = ownerGrant(1, 1)
    const identity = adapter.open(grant, 'pty-1', 'incarnation-1')!
    const params = {
      id: identity.id,
      deliveryToken: identity.deliveryToken,
      clientGeneration: identity.clientGeneration,
      ownerGeneration: identity.ownerGeneration
    }

    const first = adapter.cancel(params, grant)
    const duplicate = adapter.cancel(params, grant)

    expect(duplicate).toEqual(first)
  })
})
