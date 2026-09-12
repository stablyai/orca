import { describe, expect, it, vi } from 'vitest'
import { buildCodexResetCreditExpectedScope } from '../../shared/codex-reset-credit-scope'
import type { CodexManagedAccount } from '../../shared/managed-account-types'
import { toCodexManagedAccountSummary } from './codex-account-service-types'
import type { CodexManagedHomePath } from './codex-managed-home-path'
import {
  ManagedCodexHomeTemporarilyUnavailableError,
  UntrustedManagedCodexHomeError
} from './host-codex-managed-home-ownership'
import {
  createResetCreditLimits,
  createResetRateLimitState
} from './service-reset-credit-test-fixtures'
import { validateCodexResetCreditScope } from './codex-reset-credit-scope-validation'

/**
 * Spending a reset credit is an irreversible provider mutation. It was gated on
 * proven ownership for `runtime: 'host'` only, so a WSL selection reached the
 * provider with no ownership check at all — a different bug from misclassifying
 * one, and the reason the tri-state was bypassable from a normal caller.
 */
const WSL_TARGET = { runtime: 'wsl' as const, wslDistro: 'Ubuntu' }

function wslAccount(): CodexManagedAccount {
  return {
    id: 'account-wsl',
    email: 'wsl@example.com',
    managedHomePath:
      '\\\\wsl.localhost\\Ubuntu\\home\\dev\\.local\\share\\orca\\codex-accounts\\account-wsl\\home',
    managedHomeRuntime: 'wsl',
    wslDistro: 'Ubuntu',
    wslLinuxHomePath: '/home/dev/.local/share/orca/codex-accounts/account-wsl/home',
    providerAccountId: null,
    workspaceLabel: null,
    workspaceAccountId: null,
    createdAt: 10,
    updatedAt: 20,
    lastAuthenticatedAt: 20
  }
}

function buildDependencies(assertImpl: () => string) {
  const account = wslAccount()
  const limits = createResetCreditLimits()
  const rateLimitState = createResetRateLimitState(limits, WSL_TARGET)
  const assertSpy = vi.fn(assertImpl)
  const expectedScope = buildCodexResetCreditExpectedScope({
    target: WSL_TARGET,
    account: toCodexManagedAccountSummary(account),
    limits
  })
  if (!expectedScope) {
    throw new Error('fixture did not produce a reset-credit scope')
  }
  return {
    expectedScope,
    assertSpy,
    dependencies: {
      store: {
        getSettings: () => ({
          codexManagedAccounts: [account],
          activeCodexManagedAccountId: null,
          activeCodexManagedAccountIdsByRuntime: { host: null, wsl: { Ubuntu: account.id } }
        })
      },
      rateLimits: { getState: () => rateLimitState },
      managedHomePaths: { assert: assertSpy } as unknown as CodexManagedHomePath,
      toSummary: toCodexManagedAccountSummary
    } as never
  }
}

describe('reset-credit ownership gate on the WSL lane', () => {
  it('proves ownership before an irreversible provider mutation', () => {
    const { expectedScope, assertSpy, dependencies } = buildDependencies(
      () =>
        '\\\\wsl.localhost\\Ubuntu\\home\\dev\\.local\\share\\orca\\codex-accounts\\account-wsl\\home'
    )

    validateCodexResetCreditScope(
      expectedScope,
      { kind: 'providerMutation', requireCurrentOffer: false },
      dependencies
    )

    expect(assertSpy).toHaveBeenCalledWith(wslAccount().managedHomePath, 'account-wsl')
  })

  it('refuses when the home is proven to belong to another account', () => {
    const { expectedScope, dependencies } = buildDependencies(() => {
      throw new UntrustedManagedCodexHomeError('marker mismatch')
    })

    expect(() =>
      validateCodexResetCreditScope(
        expectedScope,
        { kind: 'providerMutation', requireCurrentOffer: false },
        dependencies
      )
    ).toThrow(UntrustedManagedCodexHomeError)
  })

  it('refuses when ownership could not be determined', () => {
    const { expectedScope, dependencies } = buildDependencies(() => {
      throw new ManagedCodexHomeTemporarilyUnavailableError()
    })

    expect(() =>
      validateCodexResetCreditScope(
        expectedScope,
        { kind: 'providerMutation', requireCurrentOffer: false },
        dependencies
      )
    ).toThrow(ManagedCodexHomeTemporarilyUnavailableError)
  })

  it('does not gate a settled replay, which mutates nothing', () => {
    const { expectedScope, assertSpy, dependencies } = buildDependencies(() => {
      throw new Error('the gate must not run here')
    })

    validateCodexResetCreditScope(expectedScope, { kind: 'settledReplay' }, dependencies)

    expect(assertSpy).not.toHaveBeenCalled()
  })
})
