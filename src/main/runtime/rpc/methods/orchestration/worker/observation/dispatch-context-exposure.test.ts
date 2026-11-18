import { describe, expect, it } from 'vitest'
import { exposeNativeUsageIdentity } from './dispatch-context-exposure'

const unavailable = { status: 'unavailable', reason: 'session_not_reported' }

function identity(raw?: unknown) {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the parser reads only this column.
  return exposeNativeUsageIdentity({ native_usage_identity: raw } as never)
}

describe('native usage identity exposure', () => {
  it('does not expose private fields embedded in a stored receipt', () => {
    const exposed = identity(
      JSON.stringify({
        status: 'observed',
        agent: 'codex',
        sessionId: 'session',
        paneKey: 'pane',
        processIncarnation: 'process',
        hostScope: '{"kind":"local","hostId":"local"}',
        launchTokenHash: 'hash',
        observedAt: 1767225600000,
        launchToken: 'private-launch-authority'
      })
    )
    expect(exposed).toHaveProperty('status', 'observed')
    expect(exposed).not.toHaveProperty('launchToken')
  })

  it('rejects blank identity fields instead of reporting a usable session', () => {
    const receipt = {
      status: 'observed',
      agent: 'codex',
      sessionId: 'session',
      paneKey: 'pane',
      processIncarnation: 'process',
      hostScope: 'host',
      launchTokenHash: 'hash',
      observedAt: 1767225600000
    }
    for (const field of [
      'agent',
      'sessionId',
      'paneKey',
      'processIncarnation',
      'hostScope',
      'launchTokenHash'
    ]) {
      expect(identity(JSON.stringify({ ...receipt, [field]: ' \t' }))).toEqual(unavailable)
    }
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
