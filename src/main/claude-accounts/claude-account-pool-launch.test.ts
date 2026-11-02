import { afterEach, describe, expect, it } from 'vitest'
import type { ClaudeManagedAccountSummary } from '../../shared/managed-account-types'
import type { ProviderRateLimits } from '../../shared/rate-limit-types'
import {
  _internals,
  listClaudePaneAccounts,
  recordClaudePaneAccount
} from './claude-pane-account-registry'
import { claudePoolInputsForTarget, claudePoolSessionCounts } from './claude-account-pool-launch'
import { chooseClaudePoolAccount } from './claude-account-pool-policy'

const NOW = Date.UTC(2026, 9, 29, 12)

function summary(
  id: string,
  extra: Partial<ClaudeManagedAccountSummary> = {}
): ClaudeManagedAccountSummary {
  return {
    id,
    email: `${id}@example.test`,
    authMethod: 'subscription-oauth',
    createdAt: 0,
    updatedAt: 0,
    lastAuthenticatedAt: 0,
    ...extra
  }
}

function limits(session: number, provenance: string): ProviderRateLimits {
  return {
    provider: 'claude',
    session: { usedPercent: session, windowMinutes: 300, resetsAt: null, resetDescription: null },
    weekly: { usedPercent: 0, windowMinutes: 10_080, resetsAt: null, resetDescription: null },
    updatedAt: NOW,
    error: null,
    status: 'ok',
    usageMetadata: { authProvenance: provenance }
  }
}

afterEach(() => {
  _internals.reset()
})

describe('claude pool launch inputs', () => {
  it('counts assigned panes from the registry and leaves pinned accounts out of the choice', () => {
    recordClaudePaneAccount({
      ptyId: 'pinned',
      paneKey: null,
      accountId: 'a',
      configDir: '/a',
      launchedAt: 1,
      pinned: true,
      source: 'transcript'
    })
    recordClaudePaneAccount({
      ptyId: 'pooled',
      paneKey: null,
      accountId: 'b',
      configDir: '/b',
      launchedAt: 1,
      pinned: false,
      source: 'pool',
      assignedAccountId: 'b'
    })
    const counts = claudePoolSessionCounts(listClaudePaneAccounts())
    expect(counts).toEqual({
      assignedCounts: { a: 1, b: 1 },
      pinnedCounts: { a: 1 }
    })
    const choice = chooseClaudePoolAccount({
      accounts: [
        { id: 'a', signedIn: true, selected: true },
        { id: 'b', signedIn: true }
      ],
      usage: [
        { accountId: 'a', rateLimits: limits(0, 'profile:a'), updatedAt: NOW },
        { accountId: 'b', rateLimits: limits(30, 'profile:b'), updatedAt: NOW }
      ],
      now: NOW,
      ...counts
    })
    expect(choice).toEqual({ accountId: 'b', kind: 'chosen' })
  })

  it('reads the selected account from its own usage and ignores another runtime', () => {
    const inputs = claudePoolInputsForTarget({
      accounts: [
        summary('a'),
        summary('b'),
        summary('w', { managedAuthRuntime: 'wsl', wslDistro: 'Ubuntu' })
      ],
      selectedAccountId: 'a',
      target: { runtime: 'host' },
      selectedLimits: limits(10, 'profile:a'),
      inactive: [
        {
          accountId: 'b',
          rateLimits: limits(40, 'profile:b'),
          updatedAt: NOW,
          isFetching: false
        },
        {
          accountId: 'w',
          rateLimits: limits(0, 'profile:w'),
          updatedAt: NOW,
          isFetching: false
        }
      ]
    })
    expect(inputs.accounts.map((account) => account.id)).toEqual(['a', 'b'])
    expect(inputs.accounts.find((account) => account.id === 'a')?.selected).toBe(true)
    expect(inputs.usage.map((row) => row.accountId)).toEqual(['a', 'b'])
  })

  it("uses the selected account's own reading when an inactive row also names it", () => {
    const live = limits(10, 'profile:a')
    const inputs = claudePoolInputsForTarget({
      accounts: [summary('a'), summary('b')],
      selectedAccountId: 'a',
      target: { runtime: 'host' },
      selectedLimits: live,
      inactive: [
        {
          accountId: 'a',
          rateLimits: limits(90, 'profile:a'),
          updatedAt: NOW - 1,
          isFetching: false
        },
        {
          accountId: 'b',
          rateLimits: limits(40, 'profile:b'),
          updatedAt: NOW,
          isFetching: false
        }
      ]
    })
    expect(inputs.usage.find((row) => row.accountId === 'a')?.rateLimits).toBe(live)
    expect(
      inputs.usage.find((row) => row.accountId === 'b')?.rateLimits?.session?.usedPercent
    ).toBe(40)
  })
})
