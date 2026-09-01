import { describe, expect, it } from 'vitest'
import { canonicalAgentSessionTranscriptIdentity } from './agent-session-transcript-identity'

describe('canonicalAgentSessionTranscriptIdentity', () => {
  it('normalizes POSIX and Windows transcript identities', () => {
    expect(
      canonicalAgentSessionTranscriptIdentity({
        transcriptPath: '/home/me/a/../session.jsonl',
        targetExecutionHostId: 'local',
        targetPlatform: 'linux'
      })
    ).toBe('posix:/home/me/session.jsonl')
    expect(
      canonicalAgentSessionTranscriptIdentity({
        transcriptPath: 'C:\\Users\\ME\\session.jsonl',
        targetExecutionHostId: 'local',
        targetPlatform: 'win32'
      })
    ).toBe('windows:c:/users/me/session.jsonl')
  })

  it('maps WSL UNC paths to POSIX only for the target distro', () => {
    expect(
      canonicalAgentSessionTranscriptIdentity({
        transcriptPath: '\\\\wsl$\\Ubuntu\\home\\me\\session.jsonl',
        targetExecutionHostId: 'wsl:Ubuntu',
        targetPlatform: 'linux'
      })
    ).toBe('posix:/home/me/session.jsonl')
    expect(
      canonicalAgentSessionTranscriptIdentity({
        transcriptPath: '\\\\wsl.localhost\\Debian\\home\\me\\session.jsonl',
        targetExecutionHostId: 'wsl:Ubuntu',
        targetPlatform: 'linux'
      })
    ).toBeNull()
  })

  it('compares UNC distro names with decoded execution-host ids', () => {
    expect(
      canonicalAgentSessionTranscriptIdentity({
        transcriptPath: '\\\\wsl$\\Ubuntu 22.04\\home\\me\\session.jsonl',
        targetExecutionHostId: 'wsl:Ubuntu%2022.04',
        targetPlatform: 'linux'
      })
    ).toBe('posix:/home/me/session.jsonl')
  })

  it('drops relative and malformed path evidence', () => {
    expect(
      canonicalAgentSessionTranscriptIdentity({
        transcriptPath: 'relative/session.jsonl',
        targetExecutionHostId: 'local',
        targetPlatform: 'linux'
      })
    ).toBeNull()
  })
})
