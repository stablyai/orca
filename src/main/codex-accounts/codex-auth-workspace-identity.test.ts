import { describe, expect, it } from 'vitest'
import type { CodexManagedAccount } from '../../shared/managed-account-types'
import {
  codexAuthMatchesManagedAccount,
  codexAuthMatchesSystemDefaultIdentity,
  readCodexAuthIdentity
} from './codex-auth-identity'

const email = 'same@example.com'

function auth(
  accountId: string,
  claims: Record<string, unknown>,
  profileClaims: Record<string, unknown> = {}
): string {
  const payload = Buffer.from(
    JSON.stringify({
      email,
      'https://api.openai.com/auth': { chatgpt_account_id: accountId, ...claims },
      'https://api.openai.com/profile': profileClaims
    })
  ).toString('base64url')
  return JSON.stringify({
    tokens: { account_id: accountId, id_token: `header.${payload}.signature` }
  })
}

describe('Codex personal and organization workspace identity', () => {
  it('keeps same-email personal and enterprise credentials isolated in both directions', () => {
    const personal = auth('personal-provider', { chatgpt_plan_type: 'plus' })
    const enterprise = auth('enterprise-provider', { chatgpt_plan_type: 'enterprise' })
    for (const [selectedAuth, otherAuth] of [
      [personal, enterprise],
      [enterprise, personal]
    ]) {
      const identity = readCodexAuthIdentity(selectedAuth)!
      const account: CodexManagedAccount = {
        ...identity,
        id: 'orca-account',
        email,
        managedHomePath: 'managed-home',
        createdAt: 1,
        updatedAt: 1,
        lastAuthenticatedAt: 1
      }
      expect(codexAuthMatchesManagedAccount(selectedAuth, account, selectedAuth)).toBe(true)
      expect(codexAuthMatchesManagedAccount(otherAuth, account, selectedAuth)).toBe(false)
      expect(codexAuthMatchesSystemDefaultIdentity(otherAuth, selectedAuth)).toBe(false)
    }
    expect(readCodexAuthIdentity(personal)?.workspaceLabel).toBe('Personal (Plus)')
    expect(readCodexAuthIdentity(enterprise)?.workspaceLabel).toBe('Enterprise')
  })
})
