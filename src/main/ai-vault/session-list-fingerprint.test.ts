import { describe, expect, it } from 'vitest'
import type { AiVaultListResult } from '../../shared/ai-vault-types'
import { conditionalAiVaultListResult } from './session-list-fingerprint'

const result: AiVaultListResult = { sessions: [], issues: [], scannedAt: 'first' }

describe('conditional session content replies', () => {
  it('leaves legacy calls exactly unchanged and refreshes only the scan stamp', () => {
    expect(conditionalAiVaultListResult(result, undefined)).toBe(result)
    const first = conditionalAiVaultListResult(result, null)
    expect(
      conditionalAiVaultListResult({ ...result, scannedAt: 'second' }, first.fingerprint)
    ).toEqual({
      sessions: [],
      issues: [],
      scannedAt: 'second',
      fingerprint: first.fingerprint,
      unchanged: true
    })
  })

  it('includes all content metadata and does not mistake force for an unchanged scan', () => {
    const first = conditionalAiVaultListResult(result, null)
    for (const changed of [
      { ...result, issues: [{ agent: 'codex' as const, path: 'source', message: 'warning' }] },
      { ...result, cancelled: true as const },
      { ...result, futureMetadata: 'new field' }
    ]) {
      const reply = conditionalAiVaultListResult(changed, first.fingerprint)
      expect(reply.unchanged).toBeUndefined()
      expect(reply.fingerprint).not.toBe(first.fingerprint)
    }
    expect(conditionalAiVaultListResult(result, first.fingerprint, true).unchanged).toBeUndefined()
  })
})
