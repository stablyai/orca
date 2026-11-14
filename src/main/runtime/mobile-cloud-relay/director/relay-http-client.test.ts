import { describe, expect, it, vi } from 'vitest'

import { RelayAssignRateGate } from './relay-assign-rate-gate'
import { requestRelayAssignment } from './relay-http-client'

type AssignInput = Parameters<typeof requestRelayAssignment>[0]

function assignSuccessResponse(): Response {
  return Response.json({
    v: 1,
    cellUrl: 'https://relay-c1.example',
    assignmentEpoch: 4,
    lease: 'lease-jwt'
  })
}

function fakeAssignClock(onSleep?: () => void) {
  let now = 1_000_000
  const sleeps: number[] = []
  return {
    sleeps,
    advance: (ms: number): void => {
      now += ms
    },
    options: {
      now: () => now,
      random: () => 0,
      sleep: async (ms: number): Promise<void> => {
        sleeps.push(ms)
        now += ms
        onSleep?.()
      }
    }
  }
}

describe('relay assignment rate gate', () => {
  const request = (
    input: Partial<AssignInput> & Pick<AssignInput, 'fetch' | 'assignRateGate'>
  ): Promise<unknown> =>
    requestRelayAssignment({
      directorUrl: 'https://relay.example',
      relayToken: 'scoped-token',
      relayHostId: 'AbCdEf0123_-xyZ9',
      ...input
    })

  it('keeps a Retry-After hint past the retry timer the coordinator cancels', async () => {
    const clock = fakeAssignClock()
    const assignRateGate = new RelayAssignRateGate(clock.options)
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 429, headers: { 'retry-after': '30' } }))
      .mockResolvedValueOnce(assignSuccessResponse())

    await expect(request({ fetch, assignRateGate })).rejects.toThrow('relay_assignment_failed_429')
    // Reconcile resets retry timers; the gate must retain long Retry-After and fail inline with the remainder.
    clock.advance(6_000)
    await expect(request({ fetch, assignRateGate })).rejects.toMatchObject({
      statusCode: 429,
      retryAfterMs: 24_000
    })
    expect(clock.sleeps).toEqual([])
    expect(fetch).toHaveBeenCalledTimes(1)

    clock.advance(25_000)
    await request({ fetch, assignRateGate })
    expect(fetch).toHaveBeenCalledTimes(2)
  })
})
