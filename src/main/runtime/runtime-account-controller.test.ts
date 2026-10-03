import { describe, expect, it, vi } from 'vitest'
import type { ClaudeManagedAccountSummary } from '../../shared/managed-account-types'
import { RuntimeAccountController, type RuntimeAccountServices } from './runtime-account-controller'

function summary(id: string, email: string): ClaudeManagedAccountSummary {
  return {
    id,
    email,
    managedAuthRuntime: 'host',
    wslDistro: null,
    authMethod: email ? 'subscription-oauth' : 'unknown',
    organizationUuid: null,
    organizationName: null,
    createdAt: 1,
    updatedAt: 1,
    lastAuthenticatedAt: email ? 1 : 0
  }
}

function controller() {
  const claude = {
    accounts: [summary('draft', ''), summary('ready', 'ok@example.test')],
    activeAccountId: null
  }
  const services = {
    claudeAccounts: {
      listAccounts: () => claude,
      selectAccount: vi.fn(async () => claude),
      removeAccount: vi.fn(async () => claude),
      finishProfileLogin: vi.fn(async () => claude)
    },
    codexAccounts: { listAccounts: () => ({ accounts: [], activeAccountId: null }) },
    rateLimits: { getState: () => ({}) }
  }
  const value = new RuntimeAccountController()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the controller only calls the members stubbed above in these cases.
  value.setServices(services as unknown as RuntimeAccountServices)
  return value
}

describe('RuntimeAccountController', () => {
  it('never sends an unfinished Claude sign-in as an account to clients that require an email', async () => {
    const accounts = controller()
    const expectWire = (state: { accounts: ClaudeManagedAccountSummary[] }) => {
      expect(state.accounts.map((account) => account.id)).toEqual(['ready'])
      expect(state).toMatchObject({ unfinishedAccounts: [{ id: 'draft' }] })
    }
    expectWire(accounts.getSnapshot().claude)
    expectWire(await accounts.selectClaude('ready'))
    expectWire(await accounts.removeClaude('ready'))
    expectWire(await accounts.finishClaudeProfileLogin('ready'))
  })
})
