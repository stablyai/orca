import { describe, expect, it } from 'vitest'
import type { AiVaultListResult } from '../../../shared/ai-vault/contracts/ai-vault-types'
import { conditionalAiVaultListResult } from './session-list-fingerprint'

const scan = (overrides: Partial<AiVaultListResult>): AiVaultListResult => ({
  sessions: [],
  issues: [],
  scannedAt: '2026-01-01T00:00:00.000Z',
  ...overrides
})

describe('conditionalAiVaultListResult', () => {
  it('answers unchanged when only the scan id, time or issues differ', () => {
    const first = conditionalAiVaultListResult(scan({ scanId: 'a' }), null)
    const issue = { agent: 'claude' as const, path: '/p', message: 'unreadable' }
    const second = conditionalAiVaultListResult(
      scan({ scanId: 'b', scannedAt: 'later', issues: [issue] }),
      first.fingerprint
    )
    expect(second).toMatchObject({ unchanged: true, sessions: [] })
  })
})
