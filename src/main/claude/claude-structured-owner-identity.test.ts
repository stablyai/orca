import { describe, expect, it, vi } from 'vitest'
import { CLAUDE_SPAWN_TOKEN_ENV, claudeProcessIdentity } from './claude-structured-owner-identity'

const IDENTITY = {
  sessionId: 'session-identity',
  workspaceId: 'workspace-1',
  hostId: 'local',
  agent: 'claude' as const,
  providerHandle: { kind: 'claude' as const, sessionId: 'session-1', leafUuid: 'leaf-1' }
}

describe('claude structured owner identity', () => {
  it('exports the spawn token env and records the observed process identity', async () => {
    expect(CLAUDE_SPAWN_TOKEN_ENV).toBe('ORCA_AGENT_SESSION_SPAWN_TOKEN')
    await expect(
      claudeProcessIdentity(
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
      claudeProcessIdentity({ identity: IDENTITY, spawnToken: 'spawn-a', pid: 4242 }, readStartTime)
    ).resolves.toMatchObject({ processStartTimeMs: 456 })
    expect(readStartTime).toHaveBeenCalledTimes(3)
  })
})
