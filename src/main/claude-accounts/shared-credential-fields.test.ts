import { describe, expect, it } from 'vitest'
import { mergeSharedClaudeCredentialFields, SHARED_CLAUDE_CREDENTIAL_KEYS } from './shared-credential-fields'

describe('mergeSharedClaudeCredentialFields', () => {
  it('merges the live credential shared fields into the target credential', () => {
    const target = JSON.stringify({ claudeAiOauth: { accessToken: 'target-token' } })
    const live = JSON.stringify({
      claudeAiOauth: { accessToken: 'live-token' },
      mcpOAuth: { conn1: 'v1' },
      pluginSecrets: { s: 1 }
    })
    const result = JSON.parse(mergeSharedClaudeCredentialFields(target, live))
    expect(result.claudeAiOauth).toEqual({ accessToken: 'target-token' })
    expect(result.mcpOAuth).toEqual({ conn1: 'v1' })
    expect(result.pluginSecrets).toEqual({ s: 1 })
  })

  it('is absence-authoritative: a shared key missing on live is not carried from the target', () => {
    const target = JSON.stringify({
      claudeAiOauth: { accessToken: 'target-token' },
      mcpOAuth: { stale: 'rotated-out' }
    })
    const live = JSON.stringify({ claudeAiOauth: { accessToken: 'live-token' } })
    const result = JSON.parse(mergeSharedClaudeCredentialFields(target, live))
    expect(result.mcpOAuth).toBeUndefined()
  })

  it('leaves account-scoped sibling keys on the target untouched', () => {
    const target = JSON.stringify({
      claudeAiOauth: { accessToken: 'target-token' },
      trustedDeviceToken: 'target-device-token'
    })
    const live = JSON.stringify({
      claudeAiOauth: { accessToken: 'live-token' },
      mcpOAuth: { conn1: 'v1' }
    })
    const result = JSON.parse(mergeSharedClaudeCredentialFields(target, live))
    expect(result.trustedDeviceToken).toBe('target-device-token')
    expect(result.mcpOAuth).toEqual({ conn1: 'v1' })
  })

  it('returns the target unchanged when there is no live credential to merge from', () => {
    const target = JSON.stringify({ claudeAiOauth: { accessToken: 'target-token' } })
    expect(mergeSharedClaudeCredentialFields(target, null)).toBe(target)
  })

  it('returns the target unchanged when the live value is not a JSON object (e.g. a raw managed API key)', () => {
    const target = JSON.stringify({ claudeAiOauth: { accessToken: 'target-token' } })
    expect(mergeSharedClaudeCredentialFields(target, 'sk-ant-api-not-json')).toBe(target)
  })

  it('returns the target unchanged when the target itself is not a Claude OAuth credential object (managed API key)', () => {
    const target = 'sk-ant-api-a-raw-managed-key'
    const live = JSON.stringify({ claudeAiOauth: {}, mcpOAuth: { conn1: 'v1' } })
    expect(mergeSharedClaudeCredentialFields(target, live)).toBe(target)
  })

  it('returns the target unchanged when the target JSON is malformed', () => {
    const target = '{not valid json'
    const live = JSON.stringify({ claudeAiOauth: {}, mcpOAuth: { conn1: 'v1' } })
    expect(mergeSharedClaudeCredentialFields(target, live)).toBe(target)
  })

  it('covers every documented shared key, not just mcpOAuth', () => {
    const target = JSON.stringify({ claudeAiOauth: {} })
    const liveObj: Record<string, unknown> = { claudeAiOauth: {} }
    for (const key of SHARED_CLAUDE_CREDENTIAL_KEYS) {
      liveObj[key] = { present: true }
    }
    const result = JSON.parse(mergeSharedClaudeCredentialFields(target, JSON.stringify(liveObj)))
    for (const key of SHARED_CLAUDE_CREDENTIAL_KEYS) {
      expect(result[key]).toEqual({ present: true })
    }
  })
})
