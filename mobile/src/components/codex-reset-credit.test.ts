import { beforeEach, describe, expect, it, vi } from 'vitest'

const uuid = vi.hoisted(() => ({ next: vi.fn<() => string>() }))
vi.mock('../platform/random-v4-uuid', () => ({ randomV4Uuid: uuid.next }))

import type { AccountsSnapshot, ProviderRateLimits } from './accounts-snapshot'
import {
  getActiveCodexAccountIdForRateLimitTarget,
  getCodexResetCreditOutcomeCopy,
  getCodexResetCreditScope,
  getCodexResetCreditSummary,
  requestCodexResetCredit
} from './codex-reset-credit'

const UUID = '11111111-1111-4111-8111-111111111111'

function makeLimits(availableCount: number, nextExpiresAt: number | null): ProviderRateLimits {
  return {
    provider: 'codex',
    session: null,
    weekly: null,
    rateLimitResetCredits: { availableCount, nextExpiresAt },
    updatedAt: 100,
    error: null,
    status: 'ok'
  }
}

function makeSnapshot(
  options: {
    target?: AccountsSnapshot['rateLimits']['codexTarget']
    activeHostId?: string | null
    activeWslIds?: Record<string, string | null>
    accounts?: AccountsSnapshot['codex']['accounts']
    availableCount?: number
  } = {}
): AccountsSnapshot {
  const activeHostId = options.activeHostId === undefined ? 'account-host' : options.activeHostId
  return {
    claude: {
      accounts: [],
      activeAccountId: null,
      activeAccountIdsByRuntime: { host: null, wsl: {} }
    },
    codex: {
      accounts: options.accounts ?? [
        {
          id: 'account-host',
          email: 'host@example.com',
          managedHomeRuntime: 'host',
          wslDistro: null,
          updatedAt: 10
        }
      ],
      activeAccountId: activeHostId,
      activeAccountIdsByRuntime: {
        host: activeHostId,
        wsl: options.activeWslIds ?? {}
      }
    },
    rateLimits: {
      claude: null,
      codex: makeLimits(options.availableCount ?? 1, null),
      claudeTarget: { runtime: 'host', wslDistro: null },
      codexTarget: options.target ?? { runtime: 'host', wslDistro: null },
      inactiveClaudeAccounts: [],
      inactiveCodexAccounts: []
    }
  }
}

describe('getCodexResetCreditSummary', () => {
  const now = 1_700_000_000_000

  it('hides the action when no earned credit is available', () => {
    expect(getCodexResetCreditSummary(null, now)).toBeNull()
    expect(getCodexResetCreditSummary(makeLimits(0, now + 60_000), now)).toBeNull()
  })

  it('formats singular and plural availability with the next expiry', () => {
    expect(getCodexResetCreditSummary(makeLimits(1, now + 2 * 60 * 60_000), now)).toEqual({
      availableCount: 1,
      availabilityLabel: '1 reset available',
      expiryLabel: 'Expires in 2h'
    })
    expect(getCodexResetCreditSummary(makeLimits(2, now + 90 * 60_000), now)).toEqual({
      availableCount: 2,
      availabilityLabel: '2 resets available',
      expiryLabel: 'Next expires in 1h 30m'
    })
  })
})

describe('Codex reset credit scope', () => {
  it('binds a host offer to the exact managed active account and revision', () => {
    const snapshot = makeSnapshot()

    expect(getActiveCodexAccountIdForRateLimitTarget(snapshot)).toBe('account-host')
    expect(getCodexResetCreditScope(snapshot)).toMatchObject({
      target: { runtime: 'host', wslDistro: null },
      accountId: 'account-host',
      accountRevision: 10,
      offerRevision: expect.stringMatching(/^v1:/)
    })
  })

  it('binds a WSL offer only to the exact distro selection and account', () => {
    const snapshot = makeSnapshot({
      target: { runtime: 'wsl', wslDistro: 'Ubuntu' },
      activeWslIds: { Ubuntu: 'account-wsl', Debian: 'account-debian' },
      accounts: [
        {
          id: 'account-wsl',
          email: 'wsl@example.com',
          managedHomeRuntime: 'wsl',
          wslDistro: 'Ubuntu',
          updatedAt: 20
        },
        {
          id: 'account-debian',
          email: 'debian@example.com',
          managedHomeRuntime: 'wsl',
          wslDistro: 'Debian',
          updatedAt: 30
        }
      ]
    })

    expect(getActiveCodexAccountIdForRateLimitTarget(snapshot)).toBe('account-wsl')
    expect(getCodexResetCreditScope(snapshot)).toMatchObject({
      target: { runtime: 'wsl', wslDistro: 'Ubuntu' },
      accountId: 'account-wsl',
      accountRevision: 20
    })
  })

  it('fails closed for system-default, unknown WSL distro, and account/target mismatch', () => {
    const systemDefault = makeSnapshot({ activeHostId: null })
    expect(getActiveCodexAccountIdForRateLimitTarget(systemDefault)).toBeNull()
    expect(getCodexResetCreditScope(systemDefault)).toBeNull()

    const unknownDistro = makeSnapshot({
      target: { runtime: 'wsl', wslDistro: null },
      activeWslIds: { __default__: 'account-host' }
    })
    expect(getActiveCodexAccountIdForRateLimitTarget(unknownDistro)).toBeNull()
    expect(getCodexResetCreditScope(unknownDistro)).toBeNull()

    const mismatch = makeSnapshot({
      target: { runtime: 'wsl', wslDistro: 'Ubuntu' },
      activeWslIds: { Ubuntu: 'account-host' }
    })
    expect(getCodexResetCreditScope(mismatch)).toBeNull()
  })
})

describe('getCodexResetCreditOutcomeCopy', () => {
  it.each([
    ['reset', 'Rate limits reset', 'Codex usage has been refreshed.'],
    ['alreadyRedeemed', 'Reset already applied', 'Codex usage has been refreshed.'],
    ['nothingToReset', 'Nothing to reset', 'No eligible Codex rate-limit window is exhausted.'],
    ['noCredit', 'No reset available', 'This account has no earned reset credits available.']
  ] as const)('maps %s to user-facing copy', (outcome, title, message) => {
    expect(getCodexResetCreditOutcomeCopy(outcome)).toEqual({ title, message })
  })
})

describe('requestCodexResetCredit', () => {
  beforeEach(() => {
    uuid.next
      .mockReset()
      .mockReturnValueOnce(UUID)
      .mockReturnValueOnce('22222222-2222-4222-8222-222222222222')
  })

  function reply(result: unknown) {
    return vi.fn().mockResolvedValue({
      id: 'request-1',
      ok: true,
      result,
      _meta: { runtimeId: 'runtime-1' }
    })
  }

  it('sends a fresh key and the exact scope with a 90s timeout, and keeps nothing on the phone', async () => {
    const snapshot = makeSnapshot()
    const expectedScope = getCodexResetCreditScope(snapshot)!
    const sendRequest = reply({ outcome: 'reset', scope: expectedScope, snapshot })

    await expect(requestCodexResetCredit({ sendRequest }, expectedScope)).resolves.toEqual({
      outcome: 'reset',
      scope: expectedScope,
      snapshot
    })
    expect(sendRequest).toHaveBeenCalledWith(
      'accounts.consumeCodexResetCredit',
      { idempotencyKey: UUID, expectedScope },
      { timeoutMs: 90_000 }
    )
  })

  it('mints a new key per attempt, as the desktop does, leaving retries to the host ledger', async () => {
    const snapshot = makeSnapshot()
    const expectedScope = getCodexResetCreditScope(snapshot)!
    const lost = vi.fn().mockRejectedValue(new Error('connection lost'))
    await expect(requestCodexResetCredit({ sendRequest: lost }, expectedScope)).rejects.toThrow(
      'connection lost'
    )

    // The host answers a same-offer retry under a new key with the attempt it already recorded.
    const retryKey = '22222222-2222-4222-8222-222222222222'
    const retry = reply({ outcome: 'alreadyRedeemed', scope: expectedScope, snapshot })
    await expect(
      requestCodexResetCredit({ sendRequest: retry }, expectedScope)
    ).resolves.toMatchObject({ outcome: 'alreadyRedeemed', scope: expectedScope })
    expect(retry).toHaveBeenCalledWith(
      'accounts.consumeCodexResetCredit',
      { idempotencyKey: retryKey, expectedScope },
      { timeoutMs: 90_000 }
    )
  })

  it('accepts the account unresolved attempt the host resumes when the retry names a newer offer', async () => {
    const snapshot = makeSnapshot()
    const originalScope = getCodexResetCreditScope(snapshot)!
    await expect(
      requestCodexResetCredit(
        { sendRequest: vi.fn().mockRejectedValue(new Error('lost')) },
        originalScope
      )
    ).rejects.toThrow('lost')

    // The refresh after the unknown outcome moved the offer, so the next confirm names a new one.
    const refreshed = makeSnapshot()
    refreshed.rateLimits.codex!.updatedAt = 101
    const refreshedScope = getCodexResetCreditScope(refreshed)!
    expect(refreshedScope.offerRevision).not.toBe(originalScope.offerRevision)
    const resumed = reply({ outcome: 'reset', scope: originalScope, snapshot: refreshed })
    await expect(
      requestCodexResetCredit({ sendRequest: resumed }, refreshedScope)
    ).resolves.toMatchObject({ outcome: 'reset', scope: originalScope })
  })

  it('returns a definite stale-offer rejection for the screen to re-confirm', async () => {
    const originalSnapshot = makeSnapshot()
    const originalScope = getCodexResetCreditScope(originalSnapshot)!
    const refreshedSnapshot = makeSnapshot()
    refreshedSnapshot.rateLimits.codex!.updatedAt = 101
    const staleResponse = reply({
      status: 'rejectedBeforeProvider',
      retryDisposition: 'discardAttempt',
      reason: 'offerChanged',
      scope: originalScope,
      snapshot: refreshedSnapshot
    })

    await expect(
      requestCodexResetCredit({ sendRequest: staleResponse }, originalScope)
    ).resolves.toEqual({
      status: 'rejectedBeforeProvider',
      retryDisposition: 'discardAttempt',
      reason: 'offerChanged',
      scope: originalScope,
      snapshot: refreshedSnapshot
    })
  })

  it('rejects a mismatched scope or a malformed nested snapshot', async () => {
    const snapshot = makeSnapshot()
    const expectedScope = getCodexResetCreditScope(snapshot)!
    await expect(
      requestCodexResetCredit(
        {
          sendRequest: reply({
            outcome: 'reset',
            scope: { ...expectedScope, accountId: 'other-account' },
            snapshot
          })
        },
        expectedScope
      )
    ).rejects.toThrow('Invalid reset response from host')
    await expect(
      requestCodexResetCredit(
        {
          sendRequest: reply({
            status: 'rejectedBeforeProvider',
            retryDisposition: 'discardAttempt',
            reason: 'offerChanged',
            scope: { ...expectedScope, accountRevision: expectedScope.accountRevision + 1 },
            snapshot
          })
        },
        expectedScope
      )
    ).rejects.toThrow('Invalid reset response from host')
    await expect(
      requestCodexResetCredit(
        {
          sendRequest: reply({
            outcome: 'reset',
            scope: expectedScope,
            snapshot: { ...snapshot, codex: { ...snapshot.codex, accounts: {} } }
          })
        },
        expectedScope
      )
    ).rejects.toThrow('Invalid accounts snapshot from host')
  })

  it('rejects a valid snapshot that does not describe the returned redeemed scope', async () => {
    const snapshot = makeSnapshot()
    const expectedScope = getCodexResetCreditScope(snapshot)!
    const wrongAccountSnapshot = makeSnapshot({ activeHostId: null })
    await expect(
      requestCodexResetCredit(
        {
          sendRequest: reply({
            outcome: 'reset',
            scope: expectedScope,
            snapshot: wrongAccountSnapshot
          })
        },
        expectedScope
      )
    ).rejects.toThrow('Invalid reset response from host')
  })
})
