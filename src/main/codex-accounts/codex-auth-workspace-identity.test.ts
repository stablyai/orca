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
  it.each([
    ['free', 'Personal (Free)'],
    ['go', 'Personal (Go)'],
    ['plus', 'Personal (Plus)'],
    ['pro', 'Personal (Pro)'],
    ['team', 'Team'],
    ['business', 'Business'],
    ['enterprise', 'Enterprise'],
    ['edu', 'Education']
  ])('uses the %s plan when the token omits the workspace name', (plan, label) => {
    expect(readCodexAuthIdentity(auth('provider-1', { chatgpt_plan_type: plan }))).toEqual({
      email,
      providerAccountId: 'provider-1',
      workspaceAccountId: 'provider-1',
      workspaceLabel: label
    })
  })

  it.each([undefined, null, '', 'future-plan', 42])(
    'does not infer personal membership from an unknown plan %s',
    (plan) => {
      expect(
        readCodexAuthIdentity(auth('provider-1', { chatgpt_plan_type: plan }))?.workspaceLabel
      ).toBeNull()
    }
  )

  it('preserves an explicit organization name over the plan label', () => {
    expect(
      readCodexAuthIdentity(
        auth('provider-1', { workspace_name: ' Acme ', chatgpt_plan_type: 'enterprise' })
      )?.workspaceLabel
    ).toBe('Acme')
  })

  it('uses the profile workspace name when the auth workspace name is blank', () => {
    expect(
      readCodexAuthIdentity(
        auth(
          'provider-1',
          { workspace_name: ' ', chatgpt_plan_type: 'enterprise' },
          { workspace_name: 'Acme' }
        )
      )?.workspaceLabel
    ).toBe('Acme')
  })

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

  it('does not treat a matching plan label as proof of account ownership', () => {
    const first = auth('enterprise-a', { chatgpt_plan_type: 'enterprise' })
    const second = auth('enterprise-b', { chatgpt_plan_type: 'enterprise' })
    expect(codexAuthMatchesSystemDefaultIdentity(first, second)).toBe(false)
  })
})
