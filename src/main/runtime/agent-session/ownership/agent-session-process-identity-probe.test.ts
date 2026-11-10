import { describe, expect, it, vi } from 'vitest'
import type { AgentSessionProcessIdentity } from '../../../../shared/agent-session/lifecycle/agent-session-record'
import {
  PROCESS_START_TIME_TOLERANCE_MS,
  probeAgentSessionProcessIdentity,
  probeAgentSessionReservation,
  type AgentSessionProcessProbeDeps
} from './agent-session-process-identity-probe'

const START_TIME = 1_700_000_000_000

const IDENTITY: AgentSessionProcessIdentity = {
  hostId: 'local',
  pid: 4242,
  processStartTimeMs: START_TIME,
  spawnToken: 'spawn-a'
}

function deps(overrides: AgentSessionProcessProbeDeps = {}): AgentSessionProcessProbeDeps {
  return {
    isPidPresent: () => true,
    readProcessStartTimeMs: async () => START_TIME,
    readEchoedSpawnToken: async () => 'spawn-a',
    platform: 'linux',
    ...overrides
  }
}

describe('owner identity probe', () => {
  it('does not call an unexpected host probe error proof of death', async () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('host probe unavailable'), { code: 'EIO' })
    })
    try {
      const probe = await probeAgentSessionProcessIdentity({
        identity: { ...IDENTITY, processStartTimeMs: null },
        deps: { readEchoedSpawnToken: async () => null }
      })
      expect(probe.outcome).toBe('indeterminate')
    } finally {
      kill.mockRestore()
    }
  })

  it('catches pid reuse through the spawn token', async () => {
    await expect(
      probeAgentSessionProcessIdentity({
        identity: IDENTITY,
        deps: deps({ readEchoedSpawnToken: async () => 'spawn-other' })
      })
    ).resolves.toEqual({ outcome: 'identity-mismatch', field: 'spawn-token' })
  })

  it('fails closed when an exact token and the reconstructed start time disagree', async () => {
    await expect(
      probeAgentSessionProcessIdentity({
        identity: IDENTITY,
        deps: deps({
          readProcessStartTimeMs: async () => START_TIME + PROCESS_START_TIME_TOLERANCE_MS + 1
        })
      })
    ).resolves.toEqual({
      outcome: 'indeterminate',
      reason: 'process identity evidence contradicted'
    })
  })

  it('fails closed when the pid is live but nothing PID-reuse-safe could be checked', async () => {
    // A live Windows PID without start time/token is inconclusive; treating it as a match could grant two writers.
    const probe = await probeAgentSessionProcessIdentity({
      identity: { ...IDENTITY, processStartTimeMs: null },
      deps: deps({ readEchoedSpawnToken: async () => null, platform: 'win32' })
    })
    expect(probe.outcome).toBe('indeterminate')
  })
})

describe('reservation probe', () => {
  it('declares a reservation unused only with positive proof nothing started', async () => {
    await expect(
      probeAgentSessionReservation({
        spawnToken: 'spawn-a',
        findProcessesWithSpawnToken: async () => [],
        hasProviderActivitySinceReservation: async () => false
      })
    ).resolves.toEqual({ outcome: 'reservation-unused' })
  })

  it.each([
    ['a process still carries the token', async () => [999], async () => false],
    ['the host cannot enumerate', async () => null, async () => false],
    ['provider activity is unknown', async () => [], async () => null],
    ['the provider saw activity', async () => [], async () => true]
  ] as const)('stays indeterminate when %s', async (_name, findProcesses, hasActivity) => {
    const probe = await probeAgentSessionReservation({
      spawnToken: 'spawn-a',
      findProcessesWithSpawnToken: findProcesses,
      hasProviderActivitySinceReservation: hasActivity
    })
    expect(probe.outcome).toBe('indeterminate')
  })
})
