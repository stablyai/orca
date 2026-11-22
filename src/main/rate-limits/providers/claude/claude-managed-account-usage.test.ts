import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type * as ClaudeKeychain from '../../../claude-accounts/runtime-auth/keychain'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ClaudeProfileRouter } from '../../../claude-accounts/profiles/routing/claude-profile-router'
import { installClaudeProfileRouter } from '../../../claude-accounts/profiles/routing/claude-profile-installed-router'
import { fetchInactiveClaudeAccountUsage } from './claude-managed-account-usage'

vi.mock('./claude-oauth-usage-request', () => ({
  fetchClaudeOAuthUsage: async (token: string) => ({
    provider: 'claude',
    session: {
      usedPercent: token === 'personal-token' ? 38 : 91,
      windowMinutes: 300,
      resetsAt: null,
      resetDescription: null
    },
    weekly: null,
    status: 'ok',
    updatedAt: 1,
    error: null
  })
}))
vi.mock('../../../claude-accounts/runtime-auth/keychain', async (original) => ({
  ...(await original<typeof ClaudeKeychain>()),
  readActiveClaudeKeychainCredentialsStrict: async () => null
}))

let root: string
let router: ClaudeProfileRouter
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-claude-default-preview-'))
  router = new ClaudeProfileRouter({
    dataRoot: join(root, 'data'),
    userHome: join(root, 'user'),
    env: {},
    getSettings: () => ({
      activeClaudeManagedAccountId: 'work',
      claudeManagedAccounts: [
        {
          id: 'work',
          email: 'work@example.com',
          managedAuthPath: join(root, 'unused'),
          authMethod: 'subscription-oauth',
          createdAt: 1,
          updatedAt: 1,
          lastAuthenticatedAt: 1
        }
      ],
      agentStatusHooksEnabled: false,
      disabledTuiAgents: []
    })
  })
  installClaudeProfileRouter(router)
  for (const [home, token] of [
    [router.systemDefaultHome(), 'personal-token'],
    [router.accountHome('work'), 'work-token']
  ]) {
    await mkdir(home, { recursive: true })
    await writeFile(
      join(home, '.credentials.json'),
      JSON.stringify({ claudeAiOauth: { accessToken: token } })
    )
  }
})
afterEach(async () => {
  installClaudeProfileRouter(undefined)
  await rm(root, { recursive: true, force: true })
})

it('reads real system-default credentials separately while the host stays on a managed account', async () => {
  const personal = await fetchInactiveClaudeAccountUsage({
    id: 'system-default:host:["personal@example.com","personal-org"]'
  })
  const work = await fetchInactiveClaudeAccountUsage({ id: 'work' })
  expect(personal.session?.usedPercent).toBe(38)
  expect(work.session?.usedPercent).toBe(91)
  expect(router.selectedProfile()?.accountId).toBe('work')
})
