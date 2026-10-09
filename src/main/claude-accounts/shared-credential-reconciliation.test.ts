import { describe, expect, it } from 'vitest'
import { reconcileSharedClaudeCredentialFields } from './shared-credential-fields'

const original = { accessToken: 'access', refreshToken: 'refresh' }
const rotated = { accessToken: 'rotated-access', refreshToken: 'rotated-refresh' }
const baseline = JSON.stringify({
  mcpOAuth: { figma: original },
  pluginSecrets: { plugin: 'secret' }
})

describe('live Claude connector reconciliation', () => {
  it('combines independent server grants on startup without importing account identity', () => {
    const sources = [
      JSON.stringify({ claudeAiOauth: { accessToken: 'account' }, mcpOAuth: { figma: original } }),
      JSON.stringify({
        mcpOAuth: { notion: rotated },
        mcpOAuthClientConfig: { notion: { clientId: 'client' } }
      }),
      '{}'
    ]
    const expected = {
      mcpOAuth: { figma: original, notion: rotated },
      mcpOAuthClientConfig: { notion: { clientId: 'client' } }
    }
    expect(JSON.parse(reconcileSharedClaudeCredentialFields(sources, null))).toEqual(expected)
    expect(JSON.parse(reconcileSharedClaudeCredentialFields(sources.toReversed(), null))).toEqual(
      expected
    )
  })

  it('combines independent rotations and additions against the previous write', () => {
    const sources = [
      JSON.stringify({ mcpOAuth: { figma: rotated }, pluginSecrets: { plugin: 'secret' } }),
      JSON.stringify({
        mcpOAuth: { figma: original, notion: original },
        pluginSecrets: { plugin: 'new-secret' }
      }),
      baseline
    ]
    const expected = {
      mcpOAuth: { figma: rotated, notion: original },
      pluginSecrets: { plugin: 'new-secret' }
    }
    expect(JSON.parse(reconcileSharedClaudeCredentialFields(sources, baseline))).toEqual(expected)
    expect(
      JSON.parse(reconcileSharedClaudeCredentialFields(sources.toReversed(), baseline))
    ).toEqual(expected)
  })

  it('keeps a revocation while another store adds an unrelated server', () => {
    const sources = [
      JSON.stringify({ mcpOAuth: {}, pluginSecrets: { plugin: 'secret' } }),
      JSON.stringify({
        mcpOAuth: { figma: original, notion: rotated },
        pluginSecrets: { plugin: 'secret' }
      }),
      baseline
    ]
    expect(JSON.parse(reconcileSharedClaudeCredentialFields(sources, baseline))).toEqual({
      mcpOAuth: { notion: rotated },
      pluginSecrets: { plugin: 'secret' }
    })
  })

  it.each([null, baseline])(
    'rejects conflicting server token pairs with baseline %s',
    (previous) => {
      const sources = [
        JSON.stringify({ mcpOAuth: { figma: rotated } }),
        JSON.stringify({
          mcpOAuth: { figma: { accessToken: 'other-access', refreshToken: 'other-refresh' } }
        })
      ]
      expect(() => reconcileSharedClaudeCredentialFields(sources, previous)).toThrow(
        'live connector credentials conflict'
      )
      expect(() => reconcileSharedClaudeCredentialFields(sources.toReversed(), previous)).toThrow(
        'live connector credentials conflict'
      )
    }
  )

  it('does not recombine access and refresh tokens from different writes', () => {
    const sources = [
      JSON.stringify({ mcpOAuth: { figma: { ...original, accessToken: 'new-access' } } }),
      JSON.stringify({ mcpOAuth: { figma: { ...original, refreshToken: 'new-refresh' } } })
    ]
    expect(() => reconcileSharedClaudeCredentialFields(sources, baseline)).toThrow(
      'live connector credentials conflict'
    )
  })

  it('does not infer MCP freshness from Claude account-token expiry', () => {
    const sources = [
      JSON.stringify({ claudeAiOauth: { expiresAt: 1 }, mcpOAuth: { figma: original } }),
      JSON.stringify({ claudeAiOauth: { expiresAt: 9999999999999 }, mcpOAuth: { figma: rotated } })
    ]
    expect(() => reconcileSharedClaudeCredentialFields(sources, null)).toThrow(
      'live connector credentials conflict'
    )
  })

  it('rejects conflicting non-server fields instead of combining their secrets', () => {
    expect(() =>
      reconcileSharedClaudeCredentialFields(
        [
          JSON.stringify({ pluginSecrets: { plugin: 'one' } }),
          JSON.stringify({ pluginSecrets: { plugin: 'two' } })
        ],
        null
      )
    ).toThrow('live connector credentials conflict')
  })

  it('does not resurrect the last-written grants when every live store is missing', () => {
    expect(reconcileSharedClaudeCredentialFields([], baseline)).toBe('{}')
  })

  it('treats an explicit null as an authoritative field removal after a known write', () => {
    expect(
      JSON.parse(
        reconcileSharedClaudeCredentialFields(
          [JSON.stringify({ mcpOAuth: null, pluginSecrets: { plugin: 'secret' } }), baseline],
          baseline
        )
      )
    ).toEqual({ mcpOAuth: null, pluginSecrets: { plugin: 'secret' } })
  })
})
