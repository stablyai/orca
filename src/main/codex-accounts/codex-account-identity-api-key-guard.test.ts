import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CodexAccountIdentity } from './codex-account-identity'

function idTokenWithClaims(claims: Record<string, unknown>): string {
  const payload = Buffer.from(JSON.stringify(claims), 'utf-8').toString('base64url')
  return `header.${payload}.signature`
}

function homeWithAuthJson(auth: Record<string, unknown>): string {
  const home = mkdtempSync(join(tmpdir(), 'codex-identity-'))
  writeFileSync(join(home, 'auth.json'), JSON.stringify(auth), 'utf-8')
  return home
}

describe('managed-home Codex identity', () => {
  const identity = new CodexAccountIdentity(async (candidatePath) => candidatePath)

  it('resolves no identity for an API-key login that still holds a stale tokens blob', async () => {
    const home = homeWithAuthJson({
      OPENAI_API_KEY: 'sk-test',
      tokens: {
        account_id: 'stale-account',
        id_token: idTokenWithClaims({ email: 'stale@example.com' })
      }
    })

    expect(await identity.readFromHome(home, 'account-1')).toEqual({
      email: null,
      providerAccountId: null,
      workspaceLabel: null,
      workspaceAccountId: null
    })
  })

  it('does not attribute a Bedrock API key to stale ChatGPT tokens', async () => {
    const home = homeWithAuthJson({
      auth_mode: 'bedrockApiKey',
      bedrock_api_key: { api_key: 'bedrock-test-key', region: 'us-east-2' },
      tokens: {
        account_id: 'stale-account',
        id_token: idTokenWithClaims({ email: 'stale@example.com' })
      }
    })

    expect(await identity.readFromHome(home, 'account-1')).toEqual({
      email: null,
      providerAccountId: null,
      workspaceLabel: null,
      workspaceAccountId: null
    })

    writeFileSync(
      join(home, 'auth.json'),
      JSON.stringify({
        auth_mode: 'chatgpt',
        bedrock_api_key: { api_key: 'bedrock-test-key', region: 'us-east-2' },
        tokens: {
          account_id: 'current-account',
          id_token: idTokenWithClaims({ email: 'current@example.com' })
        }
      })
    )
    expect(await identity.readFromHome(home, 'account-1')).toEqual({
      email: 'current@example.com',
      providerAccountId: 'current-account',
      workspaceLabel: null,
      workspaceAccountId: 'current-account'
    })
  })
})
