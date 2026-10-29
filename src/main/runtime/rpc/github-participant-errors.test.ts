import { describe, expect, it } from 'vitest'
import { mapRuntimeError } from './errors'

describe('GitHub member error responses', () => {
  it.each([
    ['github_participant_identity_required', 'member'],
    ['github_participant_account_missing', 'Select'],
    ['github_participant_owner_required', 'server owner'],
    ['github_participant_registry_unavailable', 'storage']
  ])('returns an actionable stable error for %s', (code, hint) => {
    const result = mapRuntimeError('request', { runtimeId: 'host' }, new Error(code))
    expect(result.error.code).toBe(code)
    expect(result.error.message).toContain(hint)
    expect(result.error.message).not.toBe(code)
  })
})
