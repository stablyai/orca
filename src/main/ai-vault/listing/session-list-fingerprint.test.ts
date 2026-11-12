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
  it('answers unchanged when only the scan id, time or issue wording differ', () => {
    const issue = { agent: 'claude' as const, path: '/p', message: 'unreadable' }
    const first = conditionalAiVaultListResult(scan({ scanId: 'a', issues: [issue] }), null)
    const second = conditionalAiVaultListResult(
      scan({ scanId: 'b', scannedAt: 'later', issues: [{ ...issue, message: 'EACCES at 12:01' }] }),
      first.fingerprint
    )
    expect(second).toMatchObject({ unchanged: true, sessions: [] })
  })

  it('answers changed when an issue appears or clears', () => {
    const first = conditionalAiVaultListResult(scan({}), null)
    const issue = { agent: 'claude' as const, path: '/p', message: 'unreadable' }
    expect(
      conditionalAiVaultListResult(scan({ issues: [issue] }), first.fingerprint)
    ).not.toHaveProperty('unchanged')
  })
})
