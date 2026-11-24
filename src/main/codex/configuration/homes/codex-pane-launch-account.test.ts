import { describe, expect, it } from 'vitest'
import { resolveCodexPaneLaunchAccount } from './codex-pane-launch-account'

const settings = {
  activeCodexManagedAccountId: 'account-b',
  activeCodexManagedAccountIdsByRuntime: undefined,
  codexManagedAccounts: [
    { id: 'account-a', managedHomePath: '/homes/account-a' },
    { id: 'account-b', managedHomePath: '/homes/account-b' }
  ]
}

function resolve(launchCodexHomePath: string | null) {
  return resolveCodexPaneLaunchAccount({
    pinnedByResume: false,
    launchCodexHomePath,
    systemCodexHomePath: '/home/user/.codex',
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: attribution reads only these settings fields.
    settings: settings as never,
    target: { runtime: 'host', wslDistro: null }
  })
}

describe('pane launch account attribution', () => {
  it('names the account that owns the home the child got, even after selection moved', () => {
    expect(resolve('/homes/account-a')).toMatchObject({ accountId: 'account-a' })
  })

  it('falls back to the selection for a home no account owns', () => {
    expect(resolve('/homes/shared')).toMatchObject({ accountId: 'account-b' })
  })
})
