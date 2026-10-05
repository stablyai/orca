import { describe, expect, it, vi } from 'vitest'
import {
  bootstrapAgentProcessIdentity,
  type AgentIdentityBootstrapDeps
} from './agent-process-identity-bootstrap'

function deps(overrides: Partial<AgentIdentityBootstrapDeps>): AgentIdentityBootstrapDeps {
  return {
    platform: 'darwin',
    readCanonical: vi.fn(async () => ({
      verdict: 'live' as const,
      startTime: 'Mon Oct  5 15:19:19 2026',
      zombie: false
    })),
    readCaptureFormatStartTime: vi.fn(async () => 'Mon Oct  5 08:19:19 2026'),
    ...overrides
  }
}

describe('bootstrapAgentProcessIdentity (R4.1-3)', () => {
  it('Linux: adopts the canonical boot-id:ticks only when the ticks equal the capture', async () => {
    const readCanonical = vi.fn(async () => ({
      verdict: 'live' as const,
      startTime: 'boot-1:12345',
      zombie: false
    }))
    await expect(
      bootstrapAgentProcessIdentity(
        { pid: 9, startTime: '12345' },
        deps({ platform: 'linux', readCanonical })
      )
    ).resolves.toEqual({ pid: 9, platform: 'linux', startTime: 'boot-1:12345' })
    // PID reused between recognition and the canonical read: different ticks, no identity.
    await expect(
      bootstrapAgentProcessIdentity(
        { pid: 9, startTime: '99999' },
        deps({ platform: 'linux', readCanonical })
      )
    ).resolves.toBeNull()
  })

  it('macOS: keeps the pinned-UTC canonical form for a capture taken in a non-UTC zone', async () => {
    await expect(
      bootstrapAgentProcessIdentity({ pid: 9, startTime: 'Mon Oct  5 08:19:19 2026' }, deps({}))
    ).resolves.toEqual({ pid: 9, platform: 'darwin', startTime: 'Mon Oct  5 15:19:19 2026' })
  })

  it('macOS: installs nothing when the PID was reused between recognition and the reads', async () => {
    const reads = ['Mon Oct  5 08:19:19 2026', 'Mon Oct  5 09:00:00 2026']
    const readCaptureFormatStartTime = vi.fn(async () => reads.shift() ?? null)
    await expect(
      bootstrapAgentProcessIdentity(
        { pid: 9, startTime: 'Mon Oct  5 08:19:19 2026' },
        deps({ readCaptureFormatStartTime })
      )
    ).resolves.toBeNull()
    await expect(
      bootstrapAgentProcessIdentity({ pid: 9, startTime: 'Sun Oct  4 01:00:00 2026' }, deps({}))
    ).resolves.toBeNull()
  })

  it('never fabricates a Windows identity', async () => {
    await expect(
      bootstrapAgentProcessIdentity({ pid: 9, startTime: 'x' }, deps({ platform: 'win32' }))
    ).resolves.toBeNull()
  })
})
