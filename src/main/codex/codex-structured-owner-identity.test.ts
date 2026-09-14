import { describe, expect, it, vi } from 'vitest'
import { codexProcessIdentity } from './codex-structured-owner-identity'

const IDENTITY = {
  sessionId: 'session-identity',
  workspaceId: 'workspace-1',
  hostId: 'local',
  agent: 'codex' as const,
  providerHandle: { kind: 'codex' as const, threadId: 'thread-1' }
}

describe('codex process identity', () => {
  it('records the observed start time alongside the spawn token', async () => {
    await expect(
      codexProcessIdentity(
        { identity: IDENTITY, spawnToken: 'spawn-a', pid: 4242 },
        async () => 123
      )
    ).resolves.toEqual({
      hostId: 'local',
      pid: 4242,
      processStartTimeMs: 123,
      spawnToken: 'spawn-a'
    })
  })

  it('retries a failed start-time read before giving up', async () => {
    const readStartTime = vi
      .fn<(pid: number) => Promise<number | null>>()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(456)
    await expect(
      codexProcessIdentity({ identity: IDENTITY, spawnToken: 'spawn-a', pid: 4242 }, readStartTime)
    ).resolves.toMatchObject({ processStartTimeMs: 456 })
    expect(readStartTime).toHaveBeenCalledTimes(3)
  })

  it('refuses an owner whose start time is unreadable rather than record one no probe can verify', async () => {
    // A null start time guarantees every later owner probe answers indeterminate, which is
    // a durable latch; refusing here is a retryable failure instead.
    const readStartTime = vi.fn(async () => null)
    await expect(
      codexProcessIdentity({ identity: IDENTITY, spawnToken: 'spawn-a', pid: 4242 }, readStartTime)
    ).rejects.toThrow('start time')
    expect(readStartTime).toHaveBeenCalledTimes(3)
  })
})
