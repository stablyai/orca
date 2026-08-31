import { describe, expect, it, vi } from 'vitest'
import type { AgentSessionProcessIdentity } from '../../shared/agent-session-record'
import {
  PROCESS_START_TIME_TOLERANCE_MS,
  probeAgentSessionProcessIdentities,
  probeAgentSessionProcessIdentity,
  probeAgentSessionReservation,
  readProcessStartTimeMs,
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
  it('shares one process-table read across a batch without weakening identity checks', async () => {
    const readProcessStartTimes = vi.fn(
      async () =>
        new Map([
          [4242, START_TIME],
          [4243, START_TIME + PROCESS_START_TIME_TOLERANCE_MS + 1]
        ])
    )
    const probes = await probeAgentSessionProcessIdentities({
      identities: [IDENTITY, { ...IDENTITY, pid: 4243, spawnToken: 'spawn-b' }],
      deps: {
        isPidPresent: () => true,
        readEchoedSpawnToken: async () => null,
        readProcessStartTimesMs: readProcessStartTimes,
        platform: 'darwin'
      }
    })

    expect(readProcessStartTimes).toHaveBeenCalledOnce()
    expect(readProcessStartTimes).toHaveBeenCalledWith([4242, 4243], 'darwin')
    expect(probes).toEqual([
      { outcome: 'identity-matched', matchedOn: ['process-start-time'] },
      { outcome: 'identity-mismatch', field: 'process-start-time' }
    ])
  })

  it('reports an observed exit without touching the host', () => {
    return expect(
      probeAgentSessionProcessIdentity({
        identity: IDENTITY,
        observedExit: true,
        deps: deps({
          isPidPresent: () => {
            throw new Error('must not probe after an observed exit')
          }
        })
      })
    ).resolves.toEqual({ outcome: 'exit-observed' })
  })

  it('reports an absent pid as proven death', async () => {
    await expect(
      probeAgentSessionProcessIdentity({
        identity: IDENTITY,
        deps: deps({ isPidPresent: () => false })
      })
    ).resolves.toEqual({ outcome: 'pid-absent' })
  })

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
    // The pid is live and started at the recorded time, but it is a different process.
    await expect(
      probeAgentSessionProcessIdentity({
        identity: IDENTITY,
        deps: deps({ readEchoedSpawnToken: async () => 'spawn-other' })
      })
    ).resolves.toEqual({ outcome: 'identity-mismatch', field: 'spawn-token' })
  })

  it('catches pid reuse through the start time when no token comes back', async () => {
    await expect(
      probeAgentSessionProcessIdentity({
        identity: IDENTITY,
        deps: deps({
          readEchoedSpawnToken: async () => null,
          readProcessStartTimeMs: async () => START_TIME + PROCESS_START_TIME_TOLERANCE_MS + 1
        })
      })
    ).resolves.toEqual({ outcome: 'identity-mismatch', field: 'process-start-time' })
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

  it('tolerates start-time jitter inside the tolerance', async () => {
    await expect(
      probeAgentSessionProcessIdentity({
        identity: IDENTITY,
        deps: deps({
          readEchoedSpawnToken: async () => null,
          readProcessStartTimeMs: async () => START_TIME + PROCESS_START_TIME_TOLERANCE_MS
        })
      })
    ).resolves.toEqual({ outcome: 'identity-matched', matchedOn: ['process-start-time'] })
  })

  it('reports every element it could actually verify', async () => {
    await expect(
      probeAgentSessionProcessIdentity({ identity: IDENTITY, deps: deps() })
    ).resolves.toEqual({
      outcome: 'identity-matched',
      matchedOn: ['spawn-token', 'process-start-time']
    })
  })

  it('fails closed when the pid is live but nothing PID-reuse-safe could be checked', async () => {
    // The Windows case: no start time recorded and no token echo, so a bare pid match is all the
    // host has — and a bare pid match is what mints a second writer.
    const probe = await probeAgentSessionProcessIdentity({
      identity: { ...IDENTITY, processStartTimeMs: null },
      deps: deps({ readEchoedSpawnToken: async () => null, platform: 'win32' })
    })
    expect(probe.outcome).toBe('indeterminate')
  })

  it('fails closed when the host errors instead of answering', async () => {
    const probe = await probeAgentSessionProcessIdentity({
      identity: { ...IDENTITY, processStartTimeMs: null },
      deps: deps({
        readEchoedSpawnToken: async () => {
          throw new Error('handshake unavailable')
        }
      })
    })
    expect(probe.outcome).toBe('indeterminate')
  })

  it('still proves life from the token when the start time is unreadable', async () => {
    await expect(
      probeAgentSessionProcessIdentity({
        identity: IDENTITY,
        deps: deps({ readProcessStartTimeMs: async () => null })
      })
    ).resolves.toEqual({ outcome: 'identity-matched', matchedOn: ['spawn-token'] })
  })

  it('reads a process-table start time on Windows when running there', async () => {
    const observed = await readProcessStartTimeMs(process.pid, 'win32')
    expect(observed === null).toBe(process.platform !== 'win32')
  })

  it('reads a start time for the current process on this platform', async () => {
    const observed = await readProcessStartTimeMs(process.pid)
    if (
      process.platform === 'linux' ||
      process.platform === 'darwin' ||
      process.platform === 'win32'
    ) {
      expect(observed).not.toBeNull()
      expect(Math.abs((observed as number) - (Date.now() - process.uptime() * 1000))).toBeLessThan(
        60_000
      )
    } else {
      expect(observed).toBeNull()
    }
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

  it('stays indeterminate when enumeration throws', async () => {
    const probe = await probeAgentSessionReservation({
      spawnToken: 'spawn-a',
      findProcessesWithSpawnToken: async () => {
        throw new Error('ps unavailable')
      },
      hasProviderActivitySinceReservation: async () => false
    })
    expect(probe.outcome).toBe('indeterminate')
  })
})
