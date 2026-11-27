import { describe, expect, it } from 'vitest'
import {
  parseMistralApiKeyFromDotenv,
  parseMistralVibeOidcTokens
} from './mistral-vibe-credentials'
import { mapMistralVibeBudgetResponse } from './mistral-vibe-usage-fetcher'

describe('Mistral Vibe usage parsing', () => {
  it('maps the Vibe Code budget to a clamped monthly window', () => {
    const mapped = mapMistralVibeBudgetResponse({
      vibe_budget: {
        usage_percentage: 140,
        initial_budget: 20,
        reset_at: '2026-12-01T00:00:00Z',
        payg_enabled: false
      }
    })
    expect(mapped.status).toBe('ok')
    expect(mapped.monthly?.usedPercent).toBe(100)
    expect(mapped.monthly?.resetsAt).toBe(Date.UTC(2026, 11, 1))
    expect(mapped.monthly?.windowMinutes).toBe(43_200)

    expect(mapMistralVibeBudgetResponse({ vibe_budget: null }).status).toBe('unavailable')
    expect(
      mapMistralVibeBudgetResponse({ vibe_budget: { usage_percentage: 5, initial_budget: 0 } })
        .status
    ).toBe('unavailable')
    expect(
      mapMistralVibeBudgetResponse({ vibe_budget: { usage_percentage: '5', initial_budget: 1 } })
        .status
    ).toBe('error')
  })

  it('reads MISTRAL_API_KEY from a dotenv file like python-dotenv', () => {
    expect(parseMistralApiKeyFromDotenv('OTHER=1\nMISTRAL_API_KEY=abc123 # note\n')).toBe('abc123')
    expect(parseMistralApiKeyFromDotenv('export MISTRAL_API_KEY="a b#c"\r\n')).toBe('a b#c')
    expect(parseMistralApiKeyFromDotenv("MISTRAL_API_KEY='first'\nMISTRAL_API_KEY=second")).toBe(
      'second'
    )
    expect(parseMistralApiKeyFromDotenv('MY_MISTRAL_API_KEY=nope\nMISTRAL_API_KEY=')).toBeNull()
  })

  it('reads the OIDC slot only with the tenant the gateway requires', () => {
    const tokens = {
      id_token: 'id',
      id_token_expires_at: 1_900_000_000,
      tenant: { selection: '', organization_id: 'org', workspace_id: 'ws' }
    }
    expect(parseMistralVibeOidcTokens(JSON.stringify(tokens))).toEqual({
      kind: 'oidc',
      session: {
        idToken: 'id',
        idTokenExpiresAt: 1_900_000_000,
        organizationId: 'org',
        workspaceId: 'ws'
      }
    })
    expect(parseMistralVibeOidcTokens(JSON.stringify({ ...tokens, tenant: null }))).toEqual({
      kind: 'oidc-without-tenant'
    })
    expect(parseMistralVibeOidcTokens(JSON.stringify({ ...tokens, id_token: '' }))).toBeNull()
    expect(parseMistralVibeOidcTokens('not json')).toBeNull()
  })
})
