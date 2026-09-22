import { describe, expect, it } from 'vitest'
import { getSelectedClaudeAccountIdForTarget } from '../claude-accounts/runtime-selection'
import {
  structuredClaudeMatchesActiveManagedAccount,
  type ClaudeManagedAccountGateSettings
} from './claude-structured-managed-account-support'

function account(id: string, managedAuthRuntime: 'host' | 'wsl') {
  return {
    id,
    email: `${id}@example.com`,
    managedAuthPath: `/managed/${id}`,
    managedAuthRuntime,
    authMethod: 'subscription-oauth' as const,
    createdAt: 0,
    updatedAt: 0,
    lastAuthenticatedAt: 0
  }
}

function settings(
  overrides: Partial<ClaudeManagedAccountGateSettings>
): ClaudeManagedAccountGateSettings {
  return { claudeManagedAccounts: [], activeClaudeManagedAccountId: null, ...overrides }
}

describe('structuredClaudeMatchesActiveManagedAccount', () => {
  it('allows an unmanaged install, where nothing claims an identity', () => {
    expect(structuredClaudeMatchesActiveManagedAccount(settings({}))).toBe(true)
  })

  it('allows a selected host account, which the runtime syncs into the ambient config', () => {
    expect(
      structuredClaudeMatchesActiveManagedAccount(
        settings({
          claudeManagedAccounts: [account('host-1', 'host')],
          activeClaudeManagedAccountIdsByRuntime: { host: 'host-1', wsl: {} }
        })
      )
    ).toBe(true)
  })

  it('refuses a WSL-only managed account, which never reaches the ambient config', () => {
    expect(
      structuredClaudeMatchesActiveManagedAccount(
        settings({
          claudeManagedAccounts: [account('wsl-1', 'wsl')],
          activeClaudeManagedAccountIdsByRuntime: { host: null, wsl: { Ubuntu: 'wsl-1' } }
        })
      )
    ).toBe(false)
  })

  it('refuses when a host selection names an account that is WSL-bound or missing', () => {
    expect(
      structuredClaudeMatchesActiveManagedAccount(
        settings({
          claudeManagedAccounts: [account('wsl-1', 'wsl')],
          activeClaudeManagedAccountIdsByRuntime: { host: 'wsl-1', wsl: {} }
        })
      )
    ).toBe(false)
    expect(
      structuredClaudeMatchesActiveManagedAccount(
        settings({
          claudeManagedAccounts: [account('host-1', 'host')],
          activeClaudeManagedAccountIdsByRuntime: { host: 'gone', wsl: {} }
        })
      )
    ).toBe(false)
  })

  /** Absent and empty are the same answer: this user has no managed Claude accounts, so nothing
   *  claims an identity and the ambient path is legitimate. Only settings that cannot be READ are
   *  unknown. Treating a missing key as unknown strands profiles that simply never wrote it — the
   *  auth policy's own predicate takes `(accounts ?? [])` for exactly this reason. */
  it('treats an absent account list the same as an empty one', () => {
    expect(
      structuredClaudeMatchesActiveManagedAccount(settings({ claudeManagedAccounts: [] }))
    ).toBe(true)
    expect(
      structuredClaudeMatchesActiveManagedAccount({
        activeClaudeManagedAccountId: null
      } as unknown as ClaudeManagedAccountGateSettings)
    ).toBe(true)
  })

  it('fails closed when the settings cannot be read at all', () => {
    expect(structuredClaudeMatchesActiveManagedAccount(null)).toBe(false)
    expect(structuredClaudeMatchesActiveManagedAccount(undefined)).toBe(false)
  })

  /** The four states this gate exists to tell apart, pinned together so a change to one is visible
   *  against the others. */
  it.each([
    ['no managed accounts', [], null, true],
    ['accounts present, none active, no WSL account', [account('host-1', 'host')], null, true],
    ['host account selected', [account('host-1', 'host')], 'host-1', true],
    ['WSL-only, normalized to no host selection', [account('wsl-1', 'wsl')], null, false]
  ] as const)('resolves %s', (_name, claudeManagedAccounts, activeId, expected) => {
    expect(
      structuredClaudeMatchesActiveManagedAccount(
        settings({
          claudeManagedAccounts: [...claudeManagedAccounts],
          activeClaudeManagedAccountIdsByRuntime: { host: activeId, wsl: {} }
        })
      )
    ).toBe(expected)
  })

  /** THE discriminator, and the whole of this rule. With nothing selected for the host runtime the
   *  settings alone cannot distinguish honest deselection from the WSL-only steady state, because
   *  `pruneInvalidClaudeRuntimeSelection` empties the host slot in the second case and persists it.
   *  So the presence of ANY WSL-bound account decides. Simplifying this to "none active ->
   *  supported" re-opens the auth-identity misrepresentation this gate exists to prevent. */
  it('splits none-active on whether a WSL-bound account exists at all', () => {
    const noneActive = (accounts: ReturnType<typeof account>[]) =>
      structuredClaudeMatchesActiveManagedAccount(
        settings({
          claudeManagedAccounts: accounts,
          activeClaudeManagedAccountIdsByRuntime: { host: null, wsl: {} }
        })
      )

    expect(noneActive([account('host-1', 'host')])).toBe(true)
    expect(noneActive([account('host-1', 'host'), account('host-2', 'host')])).toBe(true)
    expect(noneActive([account('wsl-1', 'wsl')])).toBe(false)
    // Mixed list still refuses: the WSL account is present and nothing is selected.
    expect(noneActive([account('host-1', 'host'), account('wsl-1', 'wsl')])).toBe(false)
  })

  /** The gate and the auth policy must resolve the SAME account. A legacy settings blob carries the
   *  selection only in the flat `activeClaudeManagedAccountId`, which is where the accessor's
   *  fall-through lives — reading the runtime map directly silently disagrees with the policy. */
  it('resolves the same account as the auth policy on a legacy flat selection', () => {
    const legacy = settings({
      claudeManagedAccounts: [account('host-1', 'host')],
      activeClaudeManagedAccountId: 'host-1'
    })

    expect(getSelectedClaudeAccountIdForTarget(legacy, { runtime: 'host' })).toBe('host-1')
    expect(structuredClaudeMatchesActiveManagedAccount(legacy)).toBe(true)
  })

  it('agrees with the auth policy that a legacy flat WSL selection is refused', () => {
    const legacy = settings({
      claudeManagedAccounts: [account('wsl-1', 'wsl')],
      activeClaudeManagedAccountId: 'wsl-1'
    })

    expect(getSelectedClaudeAccountIdForTarget(legacy, { runtime: 'host' })).toBe('wsl-1')
    expect(structuredClaudeMatchesActiveManagedAccount(legacy)).toBe(false)
  })
})
