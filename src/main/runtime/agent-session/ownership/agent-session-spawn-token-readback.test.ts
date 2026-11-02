import { describe, expect, it } from 'vitest'
import {
  readEchoedAgentSessionSpawnToken,
  spawnTokenFromEnvironBlock
} from './agent-session-spawn-token-readback'

const IDENTITY = {
  hostId: 'local',
  pid: process.pid,
  processStartTimeMs: null,
  spawnToken: 'spawn-a'
}

describe('spawn token read-back', () => {
  it('finds the token in a NUL-separated environ block', () => {
    const block = [
      'PATH=/usr/bin',
      'ORCA_AGENT_SESSION_SPAWN_TOKEN=tok-123',
      'HOME=/home/dev'
    ].join('\0')
    expect(spawnTokenFromEnvironBlock(block)).toBe('tok-123')
  })

  it('answers null for an absent or empty token instead of guessing', () => {
    expect(spawnTokenFromEnvironBlock(['PATH=/usr/bin', 'HOME=/home/dev'].join('\0'))).toBeNull()
    expect(spawnTokenFromEnvironBlock('ORCA_AGENT_SESSION_SPAWN_TOKEN=')).toBeNull()
    // A prefix collision is not a match.
    expect(spawnTokenFromEnvironBlock('ORCA_AGENT_SESSION_SPAWN_TOKEN_EXTRA=x')).toBeNull()
  })

  it('answers null on platforms that hide process environments', async () => {
    await expect(readEchoedAgentSessionSpawnToken(IDENTITY, 'darwin')).resolves.toBeNull()
    await expect(readEchoedAgentSessionSpawnToken(IDENTITY, 'win32')).resolves.toBeNull()
  })

  it('answers null when the environ file is unreadable', async () => {
    await expect(
      readEchoedAgentSessionSpawnToken({ ...IDENTITY, pid: 2 ** 30 }, 'linux')
    ).resolves.toBeNull()
  })
})
