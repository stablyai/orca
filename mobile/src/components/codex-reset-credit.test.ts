import { beforeEach, describe, expect, it, vi } from 'vitest'

const asyncStorage = vi.hoisted(() => ({
  getItem: vi.fn(),
  setItem: vi.fn(),
  removeItem: vi.fn()
}))

vi.mock('@react-native-async-storage/async-storage', () => ({ default: asyncStorage }))

import { resetCodexResetAttemptJournalForTests } from '../storage/codex-reset-attempt-journal'
import type { AccountsSnapshot, ProviderRateLimits } from './accounts-snapshot'
import {
  getActiveCodexAccountIdForRateLimitTarget,
  getCodexResetCreditOutcomeCopy,
  getCodexResetCreditScope,
  getCodexResetCreditSummary,
  resetCodexResetCreditRequestsForTests,
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
  let values: Map<string, string>

  beforeEach(() => {
    vi.clearAllMocks()
    resetCodexResetAttemptJournalForTests()
    resetCodexResetCreditRequestsForTests()
    values = new Map()
    asyncStorage.getItem.mockImplementation(async (key: string) => values.get(key) ?? null)
    asyncStorage.setItem.mockImplementation(async (key: string, value: string) => {
      values.set(key, value)
    })
    asyncStorage.removeItem.mockImplementation(async (key: string) => {
      values.delete(key)
    })
  })

  it('persists before RPC, sends the exact scope with a 90s timeout, then clears', async () => {
    const snapshot = makeSnapshot()
    const expectedScope = getCodexResetCreditScope(snapshot)!
    const sendRequest = vi.fn().mockResolvedValue({
      id: 'request-1',
      ok: true,
      result: { outcome: 'reset', scope: expectedScope, snapshot },
      _meta: { runtimeId: 'runtime-1' }
    })

    await expect(
      requestCodexResetCredit(
        { sendRequest },
        { hostId: 'host-a', expectedScope, createIdempotencyKey: () => UUID }
      )
    ).resolves.toEqual({
      outcome: 'reset',
      scope: expectedScope,
      snapshot,
      attemptJournalRetained: false
    })
    expect(asyncStorage.setItem.mock.invocationCallOrder[0]).toBeLessThan(
      sendRequest.mock.invocationCallOrder[0]!
    )
    expect(sendRequest).toHaveBeenCalledWith(
      'accounts.consumeCodexResetCredit',
      { idempotencyKey: UUID, expectedScope },
      { timeoutMs: 90_000 }
    )
    expect(values.size).toBe(0)
  })

  it('replays the original scope and UUID after an ambiguous response and offer refresh', async () => {
    const snapshot = makeSnapshot()
    const expectedScope = getCodexResetCreditScope(snapshot)!
    const firstRequest = vi.fn().mockRejectedValue(new Error('connection lost'))

    await expect(
      requestCodexResetCredit(
        { sendRequest: firstRequest },
        { hostId: 'host-a', expectedScope, createIdempotencyKey: () => UUID }
      )
    ).rejects.toThrow('connection lost')
    expect(values.size).toBe(1)

    resetCodexResetAttemptJournalForTests()
    const refreshedSnapshot = makeSnapshot()
    refreshedSnapshot.rateLimits.codex!.updatedAt = 101
    const refreshedScope = getCodexResetCreditScope(refreshedSnapshot)!
    expect(refreshedScope.offerRevision).not.toBe(expectedScope.offerRevision)
    const createRetryKey = vi.fn(() => '22222222-2222-4222-8222-222222222222')
    const retry = vi.fn().mockResolvedValue({
      id: 'request-2',
      ok: true,
      result: { outcome: 'alreadyRedeemed', scope: expectedScope, snapshot: refreshedSnapshot },
      _meta: { runtimeId: 'runtime-1' }
    })
    const result = await requestCodexResetCredit(
      { sendRequest: retry },
      { hostId: 'host-a', expectedScope: refreshedScope, createIdempotencyKey: createRetryKey }
    )

    expect(result.scope).toEqual(expectedScope)
    expect(createRetryKey).not.toHaveBeenCalled()
    expect(retry).toHaveBeenCalledWith(
      'accounts.consumeCodexResetCredit',
      { idempotencyKey: UUID, expectedScope },
      { timeoutMs: 90_000 }
    )
  })

  it('discards a definite stale-offer attempt and creates a new key only after another confirmation', async () => {
    const originalSnapshot = makeSnapshot()
    const originalScope = getCodexResetCreditScope(originalSnapshot)!
    const refreshedSnapshot = makeSnapshot()
    refreshedSnapshot.rateLimits.codex!.updatedAt = 101
    const refreshedScope = getCodexResetCreditScope(refreshedSnapshot)!
    const staleResponse = vi.fn().mockResolvedValue({
      id: 'request-stale',
      ok: true,
      result: {
        status: 'rejectedBeforeProvider',
        retryDisposition: 'discardAttempt',
        reason: 'offerChanged',
        scope: originalScope,
        snapshot: refreshedSnapshot
      },
      _meta: { runtimeId: 'runtime-1' }
    })

    await expect(
      requestCodexResetCredit(
        { sendRequest: staleResponse },
        { hostId: 'host-a', expectedScope: originalScope, createIdempotencyKey: () => UUID }
      )
    ).resolves.toMatchObject({
      status: 'rejectedBeforeProvider',
      retryDisposition: 'discardAttempt',
      reason: 'offerChanged',
      scope: originalScope,
      snapshot: refreshedSnapshot,
      attemptJournalRetained: false
    })
    expect(values.size).toBe(0)

    const nextKey = '22222222-2222-4222-8222-222222222222'
    const createNextKey = vi.fn(() => nextKey)
    const acceptedResponse = vi.fn().mockResolvedValue({
      id: 'request-next',
      ok: true,
      result: { outcome: 'reset', scope: refreshedScope, snapshot: refreshedSnapshot },
      _meta: { runtimeId: 'runtime-1' }
    })
    await requestCodexResetCredit(
      { sendRequest: acceptedResponse },
      { hostId: 'host-a', expectedScope: refreshedScope, createIdempotencyKey: createNextKey }
    )

    expect(createNextKey).toHaveBeenCalledOnce()
    expect(acceptedResponse).toHaveBeenCalledWith(
      'accounts.consumeCodexResetCredit',
      { idempotencyKey: nextKey, expectedScope: refreshedScope },
      { timeoutMs: 90_000 }
    )
  })

  it('singleflights concurrent requests across offer refreshes in the same account scope', async () => {
    const snapshot = makeSnapshot()
    const expectedScope = getCodexResetCreditScope(snapshot)!
    const refreshedSnapshot = makeSnapshot()
    refreshedSnapshot.rateLimits.codex!.updatedAt = 101
    const refreshedScope = getCodexResetCreditScope(refreshedSnapshot)!
    let releaseRequest!: () => void
    const requestGate = new Promise<void>((resolve) => {
      releaseRequest = resolve
    })
    const sendRequest = vi.fn().mockImplementation(async () => {
      await requestGate
      return {
        id: 'request-1',
        ok: true,
        result: { outcome: 'reset', scope: expectedScope, snapshot },
        _meta: { runtimeId: 'runtime-1' }
      }
    })
    const createSecondKey = vi.fn(() => '22222222-2222-4222-8222-222222222222')

    const first = requestCodexResetCredit(
      { sendRequest },
      { hostId: 'host-a', expectedScope, createIdempotencyKey: () => UUID }
    )
    await vi.waitFor(() => expect(sendRequest).toHaveBeenCalledTimes(1))
    const second = requestCodexResetCredit(
      { sendRequest },
      { hostId: 'host-a', expectedScope: refreshedScope, createIdempotencyKey: createSecondKey }
    )
    expect(sendRequest).toHaveBeenCalledTimes(1)
    expect(createSecondKey).not.toHaveBeenCalled()

    releaseRequest()
    const [firstResult, secondResult] = await Promise.all([first, second])
    expect(secondResult).toEqual(firstResult)
    expect(sendRequest).toHaveBeenCalledTimes(1)
  })

  it('rejects a mismatched scope or malformed nested snapshot without clearing', async () => {
    const snapshot = makeSnapshot()
    const expectedScope = getCodexResetCreditScope(snapshot)!
    const mismatchedScope = { ...expectedScope, accountId: 'other-account' }
    const mismatch = vi.fn().mockResolvedValue({
      id: 'request-1',
      ok: true,
      result: { outcome: 'reset', scope: mismatchedScope, snapshot },
      _meta: { runtimeId: 'runtime-1' }
    })
    await expect(
      requestCodexResetCredit(
        { sendRequest: mismatch },
        { hostId: 'host-a', expectedScope, createIdempotencyKey: () => UUID }
      )
    ).rejects.toThrow('Invalid reset response from host')
    expect(values.size).toBe(1)

    const malformed = vi.fn().mockResolvedValue({
      id: 'request-2',
      ok: true,
      result: {
        outcome: 'reset',
        scope: expectedScope,
        snapshot: { ...snapshot, codex: { ...snapshot.codex, accounts: {} } }
      },
      _meta: { runtimeId: 'runtime-1' }
    })
    await expect(
      requestCodexResetCredit(
        { sendRequest: malformed },
        { hostId: 'host-a', expectedScope, createIdempotencyKey: () => UUID }
      )
    ).rejects.toThrow('Invalid accounts snapshot from host')
    expect(values.size).toBe(1)
  })

  it('does not clear the journal for a mismatched definite-rejection response', async () => {
    const snapshot = makeSnapshot()
    const expectedScope = getCodexResetCreditScope(snapshot)!
    const mismatch = vi.fn().mockResolvedValue({
      id: 'request-mismatch',
      ok: true,
      result: {
        status: 'rejectedBeforeProvider',
        retryDisposition: 'discardAttempt',
        reason: 'offerChanged',
        scope: { ...expectedScope, offerRevision: 'v1:wrong' },
        snapshot
      },
      _meta: { runtimeId: 'runtime-1' }
    })

    await expect(
      requestCodexResetCredit(
        { sendRequest: mismatch },
        { hostId: 'host-a', expectedScope, createIdempotencyKey: () => UUID }
      )
    ).rejects.toThrow('Invalid reset response from host')
    expect(values.size).toBe(1)
    expect(asyncStorage.removeItem).not.toHaveBeenCalled()
  })

  it('rejects a valid snapshot that does not describe the returned redeemed scope', async () => {
    const snapshot = makeSnapshot()
    const expectedScope = getCodexResetCreditScope(snapshot)!
    const wrongAccountSnapshot = makeSnapshot({ activeHostId: null })
    const sendRequest = vi.fn().mockResolvedValue({
      id: 'request-1',
      ok: true,
      result: { outcome: 'reset', scope: expectedScope, snapshot: wrongAccountSnapshot },
      _meta: { runtimeId: 'runtime-1' }
    })

    await expect(
      requestCodexResetCredit(
        { sendRequest },
        { hostId: 'host-a', expectedScope, createIdempotencyKey: () => UUID }
      )
    ).rejects.toThrow('Invalid reset response from host')
    expect(values.size).toBe(1)
  })

  it('returns an authoritative result while reporting a failed journal cleanup', async () => {
    const snapshot = makeSnapshot()
    const expectedScope = getCodexResetCreditScope(snapshot)!
    const sendRequest = vi.fn().mockResolvedValue({
      id: 'request-1',
      ok: true,
      result: { outcome: 'reset', scope: expectedScope, snapshot },
      _meta: { runtimeId: 'runtime-1' }
    })
    asyncStorage.removeItem.mockRejectedValueOnce(new Error('storage unavailable'))

    await expect(
      requestCodexResetCredit(
        { sendRequest },
        { hostId: 'host-a', expectedScope, createIdempotencyKey: () => UUID }
      )
    ).resolves.toMatchObject({ outcome: 'reset', attemptJournalRetained: true })
    expect(values.size).toBe(1)
  })

  it('retains and safely replays a definite rejection when journal cleanup fails', async () => {
    const originalSnapshot = makeSnapshot()
    const originalScope = getCodexResetCreditScope(originalSnapshot)!
    const refreshedSnapshot = makeSnapshot()
    refreshedSnapshot.rateLimits.codex!.updatedAt = 101
    const refreshedScope = getCodexResetCreditScope(refreshedSnapshot)!
    const rejectionResult = {
      status: 'rejectedBeforeProvider',
      retryDisposition: 'discardAttempt',
      reason: 'offerChanged',
      scope: originalScope,
      snapshot: refreshedSnapshot
    }
    const firstResponse = vi.fn().mockResolvedValue({
      id: 'request-1',
      ok: true,
      result: rejectionResult,
      _meta: { runtimeId: 'runtime-1' }
    })
    asyncStorage.removeItem.mockRejectedValueOnce(new Error('storage unavailable'))

    await expect(
      requestCodexResetCredit(
        { sendRequest: firstResponse },
        { hostId: 'host-a', expectedScope: originalScope, createIdempotencyKey: () => UUID }
      )
    ).resolves.toMatchObject({
      status: 'rejectedBeforeProvider',
      attemptJournalRetained: true
    })
    expect(values.size).toBe(1)

    const createRetryKey = vi.fn(() => '22222222-2222-4222-8222-222222222222')
    const retryResponse = vi.fn().mockResolvedValue({
      id: 'request-2',
      ok: true,
      result: rejectionResult,
      _meta: { runtimeId: 'runtime-1' }
    })
    await expect(
      requestCodexResetCredit(
        { sendRequest: retryResponse },
        {
          hostId: 'host-a',
          expectedScope: refreshedScope,
          createIdempotencyKey: createRetryKey
        }
      )
    ).resolves.toMatchObject({
      status: 'rejectedBeforeProvider',
      attemptJournalRetained: false
    })
    expect(createRetryKey).not.toHaveBeenCalled()
    expect(retryResponse).toHaveBeenCalledWith(
      'accounts.consumeCodexResetCredit',
      { idempotencyKey: UUID, expectedScope: originalScope },
      { timeoutMs: 90_000 }
    )
    expect(values.size).toBe(0)
  })

  it('fails closed before RPC when the journal cannot be read or written', async () => {
    const snapshot = makeSnapshot()
    const expectedScope = getCodexResetCreditScope(snapshot)!
    const sendRequest = vi.fn()
    asyncStorage.getItem.mockRejectedValueOnce(new Error('storage unavailable'))
    await expect(
      requestCodexResetCredit(
        { sendRequest },
        { hostId: 'host-a', expectedScope, createIdempotencyKey: () => UUID }
      )
    ).rejects.toThrow('storage unavailable')

    asyncStorage.setItem.mockRejectedValueOnce(new Error('disk full'))
    await expect(
      requestCodexResetCredit(
        { sendRequest },
        { hostId: 'host-a', expectedScope, createIdempotencyKey: () => UUID }
      )
    ).rejects.toThrow('disk full')
    expect(sendRequest).not.toHaveBeenCalled()
  })
})
