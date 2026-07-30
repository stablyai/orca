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
