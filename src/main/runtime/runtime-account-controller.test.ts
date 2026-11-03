import { describe, expect, it, vi } from 'vitest'
import type { ClaudeRateLimitAccountsState } from '../../shared/managed-account-types'
import { RuntimeAccountController, type RuntimeAccountServices } from './runtime-account-controller'

// The saved lane key may differ in case from the account's distro, as older selections do.
function claudeState(wslAccountId: string | null): ClaudeRateLimitAccountsState {
  return {
    activeAccountId: null,
    activeAccountIdsByRuntime: { host: null, wsl: { ubuntu: wslAccountId } },
    accounts: [
      {
        id: 'wsl-b',
        email: 'b@example.com',
        managedAuthRuntime: 'wsl',
        wslDistro: 'Ubuntu',
        authMethod: 'subscription-oauth',
        createdAt: 1,
        updatedAt: 1,
        lastAuthenticatedAt: 1
      }
    ]
  }
}

function controllerWithSwitch(): {
  accounts: RuntimeAccountController
  onClaudeSelected: ReturnType<typeof vi.fn>
} {
  const onClaudeSelected = vi.fn()
  const accounts = new RuntimeAccountController(() => ({
    claudeAccountSelected: onClaudeSelected
  }))
  const claudeAccounts = {
    listAccounts: () => claudeState(null),
    selectAccount: async (accountId: string | null) => claudeState(accountId)
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: selectClaude reads only these two methods.
  accounts.setServices({ claudeAccounts } as unknown as RuntimeAccountServices)
  return { accounts, onClaudeSelected }
}

describe('RuntimeAccountController.selectClaude', () => {
  it("tells the window about a phone switch, on the selected account's lane", async () => {
    const { accounts, onClaudeSelected } = controllerWithSwitch()
    await accounts.selectClaude('wsl-b')
    expect(onClaudeSelected).toHaveBeenCalledWith({
      target: { runtime: 'wsl', wslDistro: 'Ubuntu' },
      before: { state: claudeState(null), accountId: null },
      after: { state: claudeState('wsl-b'), accountId: 'wsl-b' }
    })
  })

  it('leaves a web client switch to the web client, which moves its own sessions', async () => {
    const { accounts, onClaudeSelected } = controllerWithSwitch()
    await accounts.selectClaude('wsl-b', { movesRunningSessions: true })
    expect(onClaudeSelected).not.toHaveBeenCalled()
  })
})
