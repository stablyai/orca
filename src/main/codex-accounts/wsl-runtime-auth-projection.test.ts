import { describe, expect, it } from 'vitest'
import {
  classifyStoredCodexAuthContents,
  type StoredCodexAuthObservation
} from './managed-codex-auth-readiness'
import {
  decideWslRuntimeAuthProjection,
  wslRuntimeAuthMayReplaceSource
} from './wsl-runtime-auth-projection'

const API_KEY = JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: 'sk-test' })

describe('decideWslRuntimeAuthProjection', () => {
  it.each(['unreadable', 'incomplete'] as const)(
    'keeps an indeterminate %s source without deselecting',
    (state) => {
      expect(
        decideWslRuntimeAuthProjection({
          runtimeAuth: observe(API_KEY),
          sourceAuth: { state, mode: null, contents: state === 'incomplete' ? '{}' : null },
          explicitAccountSwitch: false
        })
      ).toEqual({ action: 'keep', deselect: false })
    }
  )

  it('replaces only from a present source on an explicit switch', () => {
    expect(
      decideWslRuntimeAuthProjection({
        runtimeAuth: observe(API_KEY),
        sourceAuth: observe(chatGptAuth('account-1', 'refresh-1')),
        explicitAccountSwitch: true
      })
    ).toEqual({ action: 'replace' })
  })

  it('seeds an absent runtime and wipes only when both sides are absent', () => {
    const missing = missingObservation()
    expect(
      decideWslRuntimeAuthProjection({
        runtimeAuth: missing,
        sourceAuth: observe(API_KEY),
        explicitAccountSwitch: false
      })
    ).toEqual({ action: 'replace' })
    expect(
      decideWslRuntimeAuthProjection({
        runtimeAuth: missing,
        sourceAuth: missing,
        explicitAccountSwitch: false
      })
    ).toEqual({ action: 'wipe' })
  })
})

describe('wslRuntimeAuthMayReplaceSource', () => {
  it.each(['chatgpt', 'chatgptAuthTokens'] as const)(
    'requires matching identity for %s credentials',
    (mode) => {
      const first = observe(chatGptAuth('account-1', 'refresh-1', mode))
      const same = observe(chatGptAuth('account-1', 'refresh-2', mode))
      const other = observe(chatGptAuth('account-2', 'refresh-2', mode))

      expect(wslRuntimeAuthMayReplaceSource(first, same)).toBe(true)
      expect(wslRuntimeAuthMayReplaceSource(first, other)).toBe(false)
    }
  )

  it('accepts byte-identical PAT credentials but preserves differing PAT bytes', () => {
    const first = observe(
      JSON.stringify({ auth_mode: 'personalAccessToken', personal_access_token: 'pat-1' })
    )
    const other = observe(
      JSON.stringify({ auth_mode: 'personalAccessToken', personal_access_token: 'pat-2' })
    )

    expect(wslRuntimeAuthMayReplaceSource(first, first)).toBe(true)
    expect(wslRuntimeAuthMayReplaceSource(first, other)).toBe(false)
  })

  it('rejects different known and future modes', () => {
    const bedrock = observe(
      JSON.stringify({ auth_mode: 'bedrockApiKey', bedrock_api_key: { api_key: 'bedrock' } })
    )
    const agent = observe(
      JSON.stringify({ auth_mode: 'agentIdentity', agent_identity: 'identity' })
    )
    const futureOne = observe(JSON.stringify({ auth_mode: 'futureOne', credential: 'one' }))
    const futureTwo = observe(JSON.stringify({ auth_mode: 'futureTwo', credential: 'two' }))

    expect(wslRuntimeAuthMayReplaceSource(bedrock, agent)).toBe(false)
    expect(wslRuntimeAuthMayReplaceSource(futureOne, futureTwo)).toBe(false)
  })
})

function observe(contents: string): StoredCodexAuthObservation {
  return { ...classifyStoredCodexAuthContents(contents), contents }
}

function missingObservation(): StoredCodexAuthObservation {
  return { state: 'missing', mode: null, contents: null }
}

function chatGptAuth(
  accountId: string,
  refreshToken: string,
  authMode: 'chatgpt' | 'chatgptAuthTokens' = 'chatgpt'
): string {
  const payload = Buffer.from(
    JSON.stringify({
      email: `${accountId}@example.com`,
      'https://api.openai.com/auth': {
        chatgpt_account_id: accountId,
        workspace_account_id: accountId
      }
    })
  ).toString('base64url')
  return JSON.stringify({
    auth_mode: authMode,
    tokens: {
      access_token: `access-${refreshToken}`,
      id_token: `header.${payload}.signature`,
      refresh_token: authMode === 'chatgptAuthTokens' ? '' : refreshToken,
      account_id: accountId
    }
  })
}
