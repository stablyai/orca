import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CodexAccountIdentity } from './codex-account-identity'
import { readCodexAuthIdentity } from './codex-auth-identity'

/** Encodes a JWT whose payload carries the given claims; only the payload segment is read. */
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
  const identity = new CodexAccountIdentity((candidatePath) => candidatePath)

  it('resolves no identity for an API-key login that still holds a stale tokens blob', () => {
    // Why: the stale OAuth email is not who this credential authenticates as, and it is
    // the claim used to prove a shared-home auth.json belongs to the selected account.
    const home = homeWithAuthJson({
      OPENAI_API_KEY: 'sk-test',
      tokens: {
        account_id: 'stale-account',
        id_token: idTokenWithClaims({ email: 'stale@example.com' })
      }
    })

    expect(identity.readFromHome(home, 'account-1')).toEqual({
      email: null,
      providerAccountId: null,
      workspaceLabel: null,
      workspaceAccountId: null
    })
  })

  it('still resolves an OAuth identity when no API key is declared', () => {
    const home = homeWithAuthJson({
      tokens: {
        account_id: 'real-account',
        id_token: idTokenWithClaims({ email: 'real@example.com' })
      }
    })

    expect(identity.readFromHome(home, 'account-1')).toMatchObject({
      email: 'real@example.com',
      providerAccountId: 'real-account'
    })
  })
})

describe('readCodexAuthIdentity account-id fallback', () => {
  it('falls through to the auth claim for providerAccountId when tokens.account_id is blank', () => {
    // Why: a blank token field must not end the fallback chain — an empty string is not nullish.
    const contents = JSON.stringify({
      tokens: {
        account_id: '   ',
        id_token: idTokenWithClaims({
          'https://api.openai.com/auth': { chatgpt_account_id: 'claim-account' }
        })
      }
    })

    expect(readCodexAuthIdentity(contents)).toMatchObject({
      providerAccountId: 'claim-account',
      // workspaceAccountId's chain skips the auth claim and ends at the top-level one.
      workspaceAccountId: null
    })
  })

  it('falls through to the top-level claim for workspaceAccountId when tokens.account_id is blank', () => {
    const contents = JSON.stringify({
      tokens: {
        account_id: '',
        id_token: idTokenWithClaims({ chatgpt_account_id: 'top-level-account' })
      }
    })

    expect(readCodexAuthIdentity(contents)).toMatchObject({
      providerAccountId: 'top-level-account',
      workspaceAccountId: 'top-level-account'
    })
  })
})
