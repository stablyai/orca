import { describe, expect, it } from 'vitest'
import { exposeNativeUsageIdentity } from './dispatch-context-exposure'

const unavailable = { status: 'unavailable', reason: 'session_not_reported' }

function identity(raw?: unknown) {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the parser reads only this column.
  return exposeNativeUsageIdentity({ native_usage_identity: raw } as never)
}

describe('native usage identity exposure', () => {
  it('returns an observed receipt without treating it as usage ownership', () => {
    const receipt = {
      status: 'observed',
      agent: 'codex',
      sessionId: 'session',
      paneKey: 'pane',
      processIncarnation: 'process',
      hostScope: '{"kind":"local","hostId":"local"}',
      launchTokenHash: 'hash',
      observedAt: 1767225600000
    }
    expect(identity(JSON.stringify(receipt))).toEqual({
      ...receipt,
      profile: { status: 'unavailable', reason: 'profile_not_verified' },
      usageAttribution: { status: 'unavailable', reason: 'segment_ownership_unproven' }
    })
  })

  it('preserves ambiguity and treats absent or malformed receipts as unavailable', () => {
    expect(
      identity(JSON.stringify({ status: 'unavailable', reason: 'session_changed_or_shared' }))
    ).toEqual({ status: 'unavailable', reason: 'session_changed_or_shared' })
    for (const value of [undefined, null, '{', 'null', '[]', '{}', '{"status":"observed"}']) {
      expect(identity(value)).toEqual(unavailable)
    }
  })
})
