import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../shared/constants'
import type { ClaudeManagedAccountSummary } from '../../shared/managed-account-types'
import type { ProviderRateLimits, RateLimitState } from '../../shared/rate-limit-types'
import { createEmptyRateLimitState } from '../../shared/rate-limit-state-factory'
import { createClaudeAccountAutoSwitch } from './claude-account-auto-switch'
import { CLAUDE_AUTO_SWITCH_COOLDOWN_MS } from './claude-account-auto-switch-policy'

const HOST = { runtime: 'host' as const, wslDistro: null }

function account(
  id: string,
  overrides: Partial<ClaudeManagedAccountSummary> = {}
): ClaudeManagedAccountSummary {
  return {
    id,
    email: `${id}@example.com`,
    managedAuthRuntime: 'host',
    wslDistro: null,
    authMethod: 'subscription-oauth',
    createdAt: 0,
    updatedAt: 0,
    lastAuthenticatedAt: 0,
    ...overrides
  }
}

function limits(usedPercent: number, updatedAt = Date.now()): ProviderRateLimits {
  return {
    provider: 'claude',
    session: { usedPercent, windowMinutes: 300, resetsAt: null, resetDescription: null },
    weekly: null,
    updatedAt,
    error: null,
    status: 'ok'
  }
}

// `tag` names the account the active reading was fetched for, as the usage fetcher does.
function usageState(
  active: ProviderRateLimits,
  inactive: Record<string, ProviderRateLimits>,
  tag = 'profile:a',
  target: RateLimitState['claudeTarget'] = HOST
): RateLimitState {
  return createEmptyRateLimitState({
    claude: { ...active, usageMetadata: { authProvenance: tag } },
    claudeTarget: target,
    inactiveClaudeAccounts: Object.entries(inactive).map(([accountId, rateLimits]) => ({
      accountId,
      rateLimits,
      updatedAt: rateLimits.updatedAt,
      isFetching: false
    }))
  })
}

// What the usage service publishes, synchronously, once it has started reading the accounts.
function withReadUnderWay(state: RateLimitState): RateLimitState {
  return {
    ...state,
    inactiveClaudeAccounts: state.inactiveClaudeAccounts.map((usage) => ({
      ...usage,
      isFetching: true
    }))
  }
}

function setup(accounts = [account('a'), account('b'), account('c')]) {
  const settings = {
    ...getDefaultSettings('/tmp'),
    activeClaudeManagedAccountId: 'a',
    claudeAutoSwitchEnabled: true
  }
  const selectAccount = vi.fn(async (accountId: string, _target, stillWanted: () => boolean) => {
    if (!stillWanted()) {
      return false
    }
    settings.activeClaudeManagedAccountId = accountId
    return true
  })
  const fetchInactiveUsage = vi.fn(async () => {})
  const onSwitched = vi.fn()
  const autoSwitch = createClaudeAccountAutoSwitch({
    getSettings: () => settings,
    rateLimits: { fetchInactiveClaudeAccountsOnOpen: fetchInactiveUsage },
    accounts: {
      listAccounts: () => ({ accounts, activeAccountId: settings.activeClaudeManagedAccountId }),
      autoSelectAccountForTarget: selectAccount
    },
    onSwitched
  })
  // Holds the next switch in the queue until `release` runs, as a pending sign-in would.
  const holdNextSwitch = (): (() => void) => {
    let release: () => void = () => {}
    selectAccount.mockImplementationOnce(async (accountId, _target, stillWanted) => {
      await new Promise<void>((resolve) => {
        release = resolve
      })
      if (!stillWanted()) {
        return false
      }
      settings.activeClaudeManagedAccountId = accountId
      return true
    })
    return () => release()
  }
  return { settings, autoSwitch, selectAccount, fetchInactiveUsage, onSwitched, holdNextSwitch }
}

describe('createClaudeAccountAutoSwitch', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-12T09:00:00Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('moves new sessions to the account with the most room and reports it', async () => {
    const { autoSwitch, selectAccount, onSwitched } = setup()

    autoSwitch(usageState(limits(95), { b: limits(50), c: limits(20) }))
    await vi.runAllTimersAsync()

    expect(selectAccount).toHaveBeenCalledWith('c', HOST, expect.any(Function))
    expect(onSwitched).toHaveBeenCalledWith({
      accounts: [
        expect.objectContaining({ id: 'a' }),
        expect.objectContaining({ id: 'b' }),
        expect.objectContaining({ id: 'c' })
      ],
      from: expect.objectContaining({ id: 'a', email: 'a@example.com' }),
      to: expect.objectContaining({ id: 'c', email: 'c@example.com' }),
      target: HOST
    })
  })

  it('does nothing while auto-switch is off', () => {
    const { settings, autoSwitch, selectAccount, fetchInactiveUsage } = setup()
    settings.claudeAutoSwitchEnabled = false

    autoSwitch(usageState(limits(100), { b: limits(0) }))

    expect(selectAccount).not.toHaveBeenCalled()
    expect(fetchInactiveUsage).not.toHaveBeenCalled()
  })

  it('asks for a new reading of the other accounts until one is under way', async () => {
    const { autoSwitch, selectAccount, fetchInactiveUsage } = setup([account('a'), account('b')])
    const hourAgo = Date.now() - 60 * 60_000
    const stale = usageState(limits(95), { b: limits(10, hourAgo) })

    // The usage service skips a read it debounces, so an ask can start nothing.
    autoSwitch(stale)
    autoSwitch(stale)
    await Promise.resolve()
    expect(fetchInactiveUsage).toHaveBeenCalledTimes(2)

    autoSwitch(withReadUnderWay(stale))
    autoSwitch(stale)
    await Promise.resolve()
    expect(fetchInactiveUsage).toHaveBeenCalledTimes(2)
    expect(selectAccount).not.toHaveBeenCalled()
  })

  it('asks for the reading only after the update it reacted to has gone out', async () => {
    const { autoSwitch, fetchInactiveUsage } = setup([account('a'), account('b')])
    const hourAgo = Date.now() - 60 * 60_000

    // The usage service publishes from inside the ask, and must not do so mid-publish.
    autoSwitch(usageState(limits(95), { b: limits(10, hourAgo) }))
    expect(fetchInactiveUsage).not.toHaveBeenCalled()

    await Promise.resolve()
    expect(fetchInactiveUsage).toHaveBeenCalledOnce()
  })

  it('does not count a read of another runtime as a read of its own accounts', async () => {
    const { autoSwitch, fetchInactiveUsage } = setup([
      account('a'),
      account('b'),
      account('wsl', { managedAuthRuntime: 'wsl', wslDistro: 'Ubuntu' })
    ])
    const hourAgo = Date.now() - 60 * 60_000
    const state = usageState(limits(95), { b: limits(10, hourAgo), wsl: limits(0) })

    autoSwitch({
      ...state,
      inactiveClaudeAccounts: state.inactiveClaudeAccounts.map((usage) =>
        usage.accountId === 'wsl' ? { ...usage, isFetching: true } : usage
      )
    })
    await Promise.resolve()

    expect(fetchInactiveUsage).toHaveBeenCalledOnce()
  })

  it('never picks an account from another runtime or one that needs a sign-in', () => {
    const { autoSwitch, selectAccount } = setup([
      account('a'),
      account('wsl', { managedAuthRuntime: 'wsl', wslDistro: 'Ubuntu' }),
      account('signed-out', { needsSignIn: true }),
      account('b')
    ])

    autoSwitch(usageState(limits(95), { wsl: limits(0), 'signed-out': limits(0), b: limits(40) }))

    expect(selectAccount).toHaveBeenCalledWith('b', HOST, expect.any(Function))
  })

  it('leaves an account picked by hand alone until the cooldown ends', () => {
    const { settings, autoSwitch, selectAccount } = setup()
    autoSwitch(usageState(limits(30), { b: limits(95), c: limits(20) }))

    settings.activeClaudeManagedAccountId = 'b'
    autoSwitch(usageState(limits(95), { a: limits(30), c: limits(20) }, 'profile:b'))
    expect(selectAccount).not.toHaveBeenCalled()

    vi.advanceTimersByTime(CLAUDE_AUTO_SWITCH_COOLDOWN_MS)
    autoSwitch(usageState(limits(95), { a: limits(30), c: limits(20) }, 'profile:b'))
    expect(selectAccount).toHaveBeenCalledWith('c', HOST, expect.any(Function))
  })

  it("never reads the previous account's usage as the new account's", () => {
    const { settings, autoSwitch, selectAccount } = setup()
    autoSwitch(usageState(limits(50), { b: limits(10), c: limits(20) }))

    settings.activeClaudeManagedAccountId = 'b'
    autoSwitch(usageState(limits(50), { a: limits(50), c: limits(20) }, 'profile:a'))
    vi.advanceTimersByTime(1_000)
    autoSwitch(usageState(limits(100), { a: limits(50), c: limits(20) }, 'profile:a'))

    expect(selectAccount).not.toHaveBeenCalled()
  })

  it('trusts System default usage only for an account that runs on System default', () => {
    const covered = setup([account('a', { runsOnSystemDefault: true }), account('b')])
    covered.autoSwitch(usageState(limits(95), { b: limits(10) }, 'system'))
    expect(covered.selectAccount).toHaveBeenCalledWith('b', HOST, expect.any(Function))

    const own = setup([account('a'), account('b')])
    own.autoSwitch(usageState(limits(95), { b: limits(10) }, 'system'))
    expect(own.selectAccount).not.toHaveBeenCalled()
  })

  it('reads a WSL account by its distro-tagged usage', () => {
    const ubuntu = { runtime: 'wsl' as const, wslDistro: 'Ubuntu' }
    const { settings, autoSwitch, selectAccount } = setup([
      account('a', { managedAuthRuntime: 'wsl', wslDistro: 'Ubuntu' }),
      account('b', { managedAuthRuntime: 'wsl', wslDistro: 'Ubuntu' })
    ])
    settings.activeClaudeManagedAccountIdsByRuntime = { host: null, wsl: { Ubuntu: 'a' } }

    autoSwitch(usageState(limits(95), { b: limits(10) }, 'profile:a:wsl:Ubuntu', ubuntu))

    expect(selectAccount).toHaveBeenCalledWith('b', ubuntu, expect.any(Function))
  })

  it('finds the other accounts of the default WSL distro', () => {
    const defaultDistro = { runtime: 'wsl' as const, wslDistro: null }
    const { settings, autoSwitch, selectAccount } = setup([
      account('a', { managedAuthRuntime: 'wsl', wslDistro: 'Ubuntu' }),
      account('b', { managedAuthRuntime: 'wsl', wslDistro: 'Ubuntu' }),
      account('host')
    ])
    settings.activeClaudeManagedAccountIdsByRuntime = { host: null, wsl: { Ubuntu: 'a' } }

    autoSwitch(
      usageState(
        limits(95),
        { b: limits(10), host: limits(0) },
        'profile:a:wsl:Ubuntu',
        defaultDistro
      )
    )

    expect(selectAccount).toHaveBeenCalledWith('b', defaultDistro, expect.any(Function))
  })

  it("reports the switch on the accounts' own distro, as a switch from the menu does", async () => {
    const { settings, autoSwitch, onSwitched } = setup([
      account('a', { managedAuthRuntime: 'wsl', wslDistro: 'Ubuntu' }),
      account('b', { managedAuthRuntime: 'wsl', wslDistro: 'Ubuntu' })
    ])
    settings.activeClaudeManagedAccountIdsByRuntime = { host: null, wsl: { Ubuntu: 'a' } }

    autoSwitch(
      usageState(limits(95), { b: limits(10) }, 'profile:a:wsl:Ubuntu', {
        runtime: 'wsl',
        wslDistro: null
      })
    )
    await vi.runAllTimersAsync()

    expect(onSwitched).toHaveBeenCalledWith(
      expect.objectContaining({ target: { runtime: 'wsl', wslDistro: 'Ubuntu' } })
    )
  })

  it('does not wait for an account the usage service cannot read yet', async () => {
    const { autoSwitch, selectAccount, fetchInactiveUsage } = setup()
    const hourAgo = Date.now() - 60 * 60_000
    const insideRetryAfter = {
      ...limits(10, hourAgo),
      usageMetadata: { retryAtMs: Date.now() + 60_000 }
    }

    autoSwitch(usageState(limits(95), { b: limits(20), c: insideRetryAfter }))
    await Promise.resolve()

    expect(fetchInactiveUsage).not.toHaveBeenCalled()
    expect(selectAccount).toHaveBeenCalledWith('b', HOST, expect.any(Function))
  })

  it('drops a queued switch once the selection changed by hand', async () => {
    const { settings, autoSwitch, onSwitched, holdNextSwitch } = setup()
    const release = holdNextSwitch()

    autoSwitch(usageState(limits(95), { b: limits(50), c: limits(20) }))
    settings.activeClaudeManagedAccountId = 'b'
    release()
    await vi.runAllTimersAsync()

    expect(settings.activeClaudeManagedAccountId).toBe('b')
    expect(onSwitched).not.toHaveBeenCalled()
  })

  it('drops a queued switch once the usage is back under the line', async () => {
    const { settings, autoSwitch, onSwitched, holdNextSwitch } = setup()
    const release = holdNextSwitch()

    autoSwitch(usageState(limits(95), { b: limits(50), c: limits(20) }))
    vi.advanceTimersByTime(1_000)
    autoSwitch(usageState(limits(40), { b: limits(50), c: limits(20) }))
    release()
    await vi.runAllTimersAsync()

    expect(settings.activeClaudeManagedAccountId).toBe('a')
    expect(onSwitched).not.toHaveBeenCalled()
  })

  it("waits for every account's reading before picking one", async () => {
    const { autoSwitch, selectAccount, fetchInactiveUsage } = setup()
    const hourAgo = Date.now() - 60 * 60_000

    autoSwitch(usageState(limits(95), { b: limits(70), c: limits(0, hourAgo) }))
    await Promise.resolve()
    expect(fetchInactiveUsage).toHaveBeenCalledOnce()
    expect(selectAccount).not.toHaveBeenCalled()

    autoSwitch(usageState(limits(95), { b: limits(70), c: limits(0) }))
    expect(selectAccount).toHaveBeenCalledWith('c', HOST, expect.any(Function))
  })

  it('switches once while a switch is still running', () => {
    const { autoSwitch, selectAccount } = setup([account('a'), account('b')])
    selectAccount.mockReturnValue(new Promise(() => {}))

    autoSwitch(usageState(limits(100), { b: limits(10) }))
    autoSwitch(usageState(limits(100), { b: limits(10) }))

    expect(selectAccount).toHaveBeenCalledOnce()
  })

  it('picks from the accounts it could read once a read was tried', async () => {
    const { autoSwitch, selectAccount, fetchInactiveUsage } = setup()
    const hourAgo = Date.now() - 60 * 60_000
    const state = usageState(limits(95), { b: limits(20), c: limits(10, hourAgo) })
    fetchInactiveUsage.mockImplementation(async () => autoSwitch(withReadUnderWay(state)))

    autoSwitch(state)
    await Promise.resolve()
    expect(selectAccount).not.toHaveBeenCalled()

    autoSwitch(state)
    expect(fetchInactiveUsage).toHaveBeenCalledOnce()
    expect(selectAccount).toHaveBeenCalledWith('b', HOST, expect.any(Function))
  })

  it('waits for a new usage reading before trying again after a failed switch', async () => {
    const { autoSwitch, selectAccount } = setup([account('a'), account('b')])
    selectAccount.mockRejectedValueOnce(new Error('sync failed'))
    const atLimit = limits(100)

    autoSwitch(usageState(atLimit, { b: limits(10) }))
    vi.advanceTimersByTime(1_000)
    await vi.runAllTimersAsync()
    autoSwitch(usageState(atLimit, { b: limits(10) }))
    expect(selectAccount).toHaveBeenCalledOnce()

    autoSwitch(usageState(limits(100), { b: limits(10) }))
    expect(selectAccount).toHaveBeenCalledTimes(2)
  })
})
