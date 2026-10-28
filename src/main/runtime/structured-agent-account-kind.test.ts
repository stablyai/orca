import { agentSessionSignInCopyId } from '../../shared/agent-session-availability'
import { describe, expect, it } from 'vitest'
import { resolveStructuredCodexAccountKind } from './structured-agent-account-home'
import { getSystemCodexHomePath } from '../codex/codex-home-paths'
import type { CodexManagedAccount } from '../../shared/managed-account-types'
const ACCOUNT: CodexManagedAccount = {
  id: 'account-a',
  email: 'example@example.test',
  managedHomePath: '/accounts/a/home',
  managedHomeRuntime: 'host',
  createdAt: 0,
  updatedAt: 0,
  lastAuthenticatedAt: 0
}
const SETTINGS = { codexManagedAccounts: [ACCOUNT], activeCodexManagedAccountId: 'account-a' }
describe('Codex sign-in instructions follow the probed home', () => {
  it('recognizes a pinned managed account after the current selection changes', () => {
    expect(
      resolveStructuredCodexAccountKind(ACCOUNT.managedHomePath, {
        ...SETTINGS,
        activeCodexManagedAccountId: null
      })
    ).toBe('managed')
  })
  it('recognizes the system home even when Settings selects a managed account', () => {
    expect(resolveStructuredCodexAccountKind(getSystemCodexHomePath(), SETTINGS)).toBe('system')
  })
  it('keeps pinned overlay recovery instructions on the actual login', () => {
    const settings = { ...SETTINGS, activeCodexManagedAccountId: null }
    const kind = resolveStructuredCodexAccountKind(
      `/accounts/a/overlays/${'a'.repeat(32)}`,
      settings
    )
    expect(agentSessionSignInCopyId('codex', kind)).toBe('codexManagedNotSignedIn')
    expect(
      agentSessionSignInCopyId(
        'codex',
        resolveStructuredCodexAccountKind(`/accounts/system/overlays/${'a'.repeat(32)}`, SETTINGS)
      )
    ).toBe('codexSystemNotSignedIn')
  })
  it('does not infer a managed account from a custom or WSL home', () => {
    expect(resolveStructuredCodexAccountKind('/custom/home', SETTINGS)).toBeUndefined()
    expect(
      resolveStructuredCodexAccountKind(ACCOUNT.managedHomePath, {
        ...SETTINGS,
        codexManagedAccounts: [{ ...ACCOUNT, managedHomeRuntime: 'wsl' }]
      })
    ).toBeUndefined()
  })
})
