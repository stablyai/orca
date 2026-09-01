import { describe, expect, it } from 'vitest'
import { createAiVaultResumeLocator } from './ai-vault-resume-locator'

describe('createAiVaultResumeLocator', () => {
  const base = {
    executionHostId: 'local' as const,
    agent: 'codex' as const,
    sessionId: 'session-1',
    transcriptPath: '/home/me/.codex/sessions/session-1.jsonl',
    platform: 'linux' as const
  }

  it('is stable for the same canonical transcript and separates different paths', () => {
    expect(createAiVaultResumeLocator(base)).toMatch(/^[a-f0-9]{64}$/)
    expect(
      createAiVaultResumeLocator({
        ...base,
        transcriptPath: '/home/me/.codex/./sessions/a/../session-1.jsonl'
      })
    ).toBe(createAiVaultResumeLocator(base))
    expect(
      createAiVaultResumeLocator({ ...base, transcriptPath: '/other/session-1.jsonl' })
    ).not.toBe(createAiVaultResumeLocator(base))
  })

  it('normalizes Windows separators and case while retaining host identity', () => {
    const windows = {
      ...base,
      transcriptPath: 'C:\\Users\\Me\\session.jsonl',
      platform: 'win32' as const
    }
    expect(createAiVaultResumeLocator(windows)).toBe(
      createAiVaultResumeLocator({ ...windows, transcriptPath: 'c:/users/me/session.jsonl' })
    )
    expect(createAiVaultResumeLocator({ ...windows, executionHostId: 'ssh:box' })).not.toBe(
      createAiVaultResumeLocator(windows)
    )
  })
})
