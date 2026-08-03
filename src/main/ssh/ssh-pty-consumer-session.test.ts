import { describe, expect, it, vi } from 'vitest'
import type { SshChannelMultiplexer } from './ssh-channel-multiplexer'
import { openSshPtyConsumerSession } from './ssh-pty-consumer-session'

function muxReturning(result: unknown): {
  mux: SshChannelMultiplexer
  request: ReturnType<typeof vi.fn>
} {
  const request = vi.fn().mockResolvedValue(result)
  return { mux: { request } as unknown as SshChannelMultiplexer, request }
}

function legacyOwnerGrant(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    protocolVersion: 1,
    serverBuildId: 'build-a',
    clientGeneration: 3,
    role: 'session-owner',
    ownerGeneration: 7,
    ownerLease: 'lease-a',
    ...overrides
  }
}

describe('openSshPtyConsumerSession', () => {
  it('makes openClient the one request needed for token-free legacy readiness', async () => {
    const { mux, request } = muxReturning(legacyOwnerGrant())

    await expect(
      openSshPtyConsumerSession(mux, {
        clientInstanceId: 'client-a',
        expectedServerBuildId: 'build-a'
      })
    ).resolves.toEqual({
      mode: 'negotiated',
      clientInstanceId: 'client-a',
      clientGeneration: 3,
      ownerGeneration: 7,
      ownerLease: 'lease-a'
    })
    expect(request).toHaveBeenCalledWith(
      'pty.openClient',
      {
        protocolVersion: 1,
        clientInstanceId: 'client-a',
        requestedRole: 'session-owner'
      },
      { timeoutMs: 10_000 }
    )
  })

  it('carries recovery generation and lease on reconnect', async () => {
    const { mux, request } = muxReturning(
      legacyOwnerGrant({ ownerGeneration: 8, ownerLease: 'lease-b' })
    )
    await openSshPtyConsumerSession(mux, {
      clientInstanceId: 'client-a',
      expectedServerBuildId: 'build-a',
      resume: { ownerGeneration: 7, ownerLease: 'lease-a' }
    })

    expect(request.mock.calls[0][1]).toMatchObject({
      resume: { ownerGeneration: 7, ownerLease: 'lease-a' }
    })
  })

  it('rejects a prior or mismatched relay build', async () => {
    const { mux } = muxReturning(legacyOwnerGrant({ serverBuildId: 'old-build' }))

    await expect(
      openSshPtyConsumerSession(mux, {
        clientInstanceId: 'client-a',
        expectedServerBuildId: 'build-a'
      })
    ).rejects.toThrow('session contract mismatch')
  })

  it('rejects an owner lease that cannot be resumed through the relay protocol', async () => {
    const { mux } = muxReturning(legacyOwnerGrant({ ownerLease: 'x'.repeat(513) }))

    await expect(
      openSshPtyConsumerSession(mux, {
        clientInstanceId: 'client-a',
        expectedServerBuildId: 'build-a'
      })
    ).rejects.toThrow('did not grant')
  })

  it('does not silently downgrade when V1 was offered', async () => {
    const { mux } = muxReturning(legacyOwnerGrant())

    await expect(
      openSshPtyConsumerSession(mux, {
        clientInstanceId: 'client-a',
        expectedServerBuildId: 'build-a',
        outputFlowControl: { requestedWindowSu: 64 }
      })
    ).rejects.toThrow('did not grant')
  })

  it('rejects an unoffered V1 capability in a legacy session', async () => {
    const { mux } = muxReturning(
      legacyOwnerGrant({
        capabilities: { outputFlowControl: { version: 1, windowSu: 64 } }
      })
    )

    await expect(
      openSshPtyConsumerSession(mux, {
        clientInstanceId: 'client-a',
        expectedServerBuildId: 'build-a'
      })
    ).rejects.toThrow('unoffered')
  })

  it('uses explicit token-free fallback only for same-build method-not-found', async () => {
    const error = Object.assign(new Error('Method not found: pty.openClient'), { code: -32601 })
    const request = vi.fn().mockRejectedValue(error)
    const mux = { request } as unknown as SshChannelMultiplexer

    await expect(
      openSshPtyConsumerSession(mux, {
        clientInstanceId: 'client-a',
        expectedServerBuildId: 'build-a',
        allowSameBuildLegacyFallback: true,
        outputFlowControl: { requestedWindowSu: 64 }
      })
    ).resolves.toEqual({
      mode: 'legacy-fallback',
      clientInstanceId: 'client-a',
      serverBuildId: 'build-a'
    })
  })

  it.each([
    Object.assign(new Error('timeout'), { code: 'TIMEOUT' }),
    Object.assign(new Error('auth failed'), { code: -32000 }),
    Object.assign(new Error('method missing'), { code: -32601 })
  ])('does not downgrade an unproved or non-method-not-found error', async (error) => {
    const request = vi.fn().mockRejectedValue(error)
    const mux = { request } as unknown as SshChannelMultiplexer

    await expect(
      openSshPtyConsumerSession(mux, {
        clientInstanceId: 'client-a',
        expectedServerBuildId: 'build-a',
        allowSameBuildLegacyFallback: error.code !== -32601
      })
    ).rejects.toBe(error)
  })
})
