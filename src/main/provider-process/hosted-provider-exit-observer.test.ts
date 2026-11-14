import { expect, it } from 'vitest'
import { observeHostedProviderExit } from './hosted-provider-exit-observer'
import { probeAgentSessionProcessIdentity } from '../runtime/agent-session/ownership/agent-session-process-identity-probe'

it.each([1_000, 0, 4_000])(
  'does not release a writer when a replacement PID starts %ims later',
  async (difference) => {
    let now = 0
    const verdict = await observeHostedProviderExit({
      timeoutMs: 8_000,
      now: () => now,
      sleep: async (ms) => {
        now += ms
      },
      isSettled: () => false,
      query: async () => ({ state: 'unknown' }),
      probe: () =>
        probeAgentSessionProcessIdentity({
          identity: {
            pid: 42,
            hostId: 'local',
            processStartTimeMs: 10_000,
            spawnToken: 'original'
          },
          deps: {
            isPidPresent: () => true,
            readProcessStartTimeMs: async () => 10_000 + difference
          }
        })
    })
    expect(verdict).toEqual({ state: 'unproven' })
  }
)

it('settles real absence when a lost host has no retained outcome', async () => {
  const verdict = await observeHostedProviderExit({
    timeoutMs: 8_000,
    isSettled: () => false,
    query: async () => ({ state: 'unknown' }),
    probe: () =>
      probeAgentSessionProcessIdentity({
        identity: { pid: 42, hostId: 'local', processStartTimeMs: 10_000, spawnToken: 'original' },
        deps: { isPidPresent: () => false }
      })
  })
  expect(verdict).toEqual({ state: 'absent' })
})
