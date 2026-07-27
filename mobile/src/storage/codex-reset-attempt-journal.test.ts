import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CodexResetCreditExpectedScope } from '../../../src/shared/codex-reset-credit-scope'

const asyncStorage = vi.hoisted(() => ({
  getItem: vi.fn(),
  setItem: vi.fn(),
  removeItem: vi.fn()
}))

vi.mock('@react-native-async-storage/async-storage', () => ({ default: asyncStorage }))

import {
  clearCodexResetAttemptAfterAuthoritativeResponse,
  getOrCreateCodexResetAttempt,
  resetCodexResetAttemptJournalForTests
} from './codex-reset-attempt-journal'

const FIRST_UUID = '11111111-1111-4111-8111-111111111111'
const SECOND_UUID = '22222222-2222-4222-8222-222222222222'

function makeScope(
  overrides: Partial<CodexResetCreditExpectedScope> = {}
): CodexResetCreditExpectedScope {
  return {
    target: { runtime: 'host', wslDistro: null },
    accountId: 'account-a',
    accountRevision: 10,
    offerRevision: 'v1:offer-a',
    ...overrides
  }
}

describe('Codex reset attempt journal', () => {
  let values: Map<string, string>

  beforeEach(() => {
    vi.clearAllMocks()
    resetCodexResetAttemptJournalForTests()
    values = new Map()
    asyncStorage.getItem.mockImplementation(async (key: string) => values.get(key) ?? null)
    asyncStorage.setItem.mockImplementation(async (key: string, value: string) => {
      values.set(key, value)
    })
    asyncStorage.removeItem.mockImplementation(async (key: string) => {
      values.delete(key)
    })
  })

  it('persists an unresolved UUID and reuses it after a module-level remount', async () => {
    const identity = { hostId: 'host-a', expectedScope: makeScope() }
    const createFirst = vi.fn(() => FIRST_UUID)
    const first = await getOrCreateCodexResetAttempt({
      ...identity,
      createIdempotencyKey: createFirst
    })

    resetCodexResetAttemptJournalForTests()
    const createAfterRemount = vi.fn(() => SECOND_UUID)
    const restored = await getOrCreateCodexResetAttempt({
      ...identity,
      createIdempotencyKey: createAfterRemount
    })

    expect(restored).toEqual(first)
    expect(createAfterRemount).not.toHaveBeenCalled()
    expect(values.size).toBe(1)
  })

  it('isolates attempts by host and stable target/account revision scope', async () => {
    const variants = [
      { hostId: 'host-a', expectedScope: makeScope() },
      { hostId: 'host-b', expectedScope: makeScope() },
      { hostId: 'host-a', expectedScope: makeScope({ accountId: 'account-b' }) },
      { hostId: 'host-a', expectedScope: makeScope({ accountRevision: 11 }) },
      {
        hostId: 'host-a',
        expectedScope: makeScope({ target: { runtime: 'wsl', wslDistro: 'Ubuntu' } })
      }
    ]

    const attempts = await Promise.all(
      variants.map((identity, index) =>
        getOrCreateCodexResetAttempt({
          ...identity,
          createIdempotencyKey: () =>
            `${String(index + 1).repeat(8)}-${String(index + 1).repeat(4)}-4${String(index + 1).repeat(3)}-8${String(index + 1).repeat(3)}-${String(index + 1).repeat(12)}`
        })
      )
    )

    expect(new Set(attempts.map((attempt) => attempt.idempotencyKey)).size).toBe(variants.length)
    expect(values.size).toBe(variants.length)
  })

  it('replays the original exact offer after a refresh changes its offer revision', async () => {
    const originalScope = makeScope()
    const original = await getOrCreateCodexResetAttempt({
      hostId: 'host-a',
      expectedScope: originalScope,
      createIdempotencyKey: () => FIRST_UUID
    })

    resetCodexResetAttemptJournalForTests()
    const createRefreshedKey = vi.fn(() => SECOND_UUID)
    const restored = await getOrCreateCodexResetAttempt({
      hostId: 'host-a',
      expectedScope: makeScope({ offerRevision: 'v1:refreshed-offer' }),
      createIdempotencyKey: createRefreshedKey
    })

    expect(restored).toEqual(original)
    expect(restored.expectedScope).toEqual(originalScope)
    expect(createRefreshedKey).not.toHaveBeenCalled()
    expect(values.size).toBe(1)
  })

  it('keeps each account attempt while switching away and back', async () => {
    const accountA = makeScope({ accountId: 'account-a' })
    const accountB = makeScope({ accountId: 'account-b' })
    await getOrCreateCodexResetAttempt({
      hostId: 'host-a',
      expectedScope: accountA,
      createIdempotencyKey: () => FIRST_UUID
    })
    await getOrCreateCodexResetAttempt({
      hostId: 'host-a',
      expectedScope: accountB,
      createIdempotencyKey: () => SECOND_UUID
    })

    const createAfterSwitchBack = vi.fn(() => '33333333-3333-4333-8333-333333333333')
    const restoredA = await getOrCreateCodexResetAttempt({
      hostId: 'host-a',
      expectedScope: { ...accountA, offerRevision: 'v1:after-switch-back' },
      createIdempotencyKey: createAfterSwitchBack
    })

    expect(restoredA.idempotencyKey).toBe(FIRST_UUID)
    expect(createAfterSwitchBack).not.toHaveBeenCalled()
    expect(values.size).toBe(2)
  })

  it('serializes same-scope creation so concurrent callers share one durable UUID', async () => {
    let releaseWrite!: () => void
    const writeGate = new Promise<void>((resolve) => {
      releaseWrite = resolve
    })
    asyncStorage.setItem.mockImplementationOnce(async (key: string, value: string) => {
      await writeGate
      values.set(key, value)
    })
    const identity = { hostId: 'host-a', expectedScope: makeScope() }
    const createFirst = vi.fn(() => FIRST_UUID)
    const createSecond = vi.fn(() => SECOND_UUID)

    const first = getOrCreateCodexResetAttempt({
      ...identity,
      createIdempotencyKey: createFirst
    })
    await vi.waitFor(() => expect(asyncStorage.setItem).toHaveBeenCalledTimes(1))
    const second = getOrCreateCodexResetAttempt({
      ...identity,
      expectedScope: makeScope({ offerRevision: 'v1:refreshed-offer' }),
      createIdempotencyKey: createSecond
    })
    await Promise.resolve()
    expect(createSecond).not.toHaveBeenCalled()

    releaseWrite()
    await expect(Promise.all([first, second])).resolves.toMatchObject([
      { idempotencyKey: FIRST_UUID },
      { idempotencyKey: FIRST_UUID }
    ])
    expect(createSecond).not.toHaveBeenCalled()
  })

  it('fails closed on corrupt storage, read failures, write failures, and invalid UUIDs', async () => {
    const identity = { hostId: 'host-a', expectedScope: makeScope() }
    await getOrCreateCodexResetAttempt({
      ...identity,
      createIdempotencyKey: () => FIRST_UUID
    })
    const [key] = values.keys()
    values.set(key!, '{not-json')
    await expect(
      getOrCreateCodexResetAttempt({ ...identity, createIdempotencyKey: () => SECOND_UUID })
    ).rejects.toThrow(/unreadable/)

    values.clear()
    asyncStorage.getItem.mockRejectedValueOnce(new Error('storage unavailable'))
    await expect(
      getOrCreateCodexResetAttempt({ ...identity, createIdempotencyKey: () => SECOND_UUID })
    ).rejects.toThrow('storage unavailable')

    asyncStorage.setItem.mockRejectedValueOnce(new Error('disk full'))
    await expect(
      getOrCreateCodexResetAttempt({ ...identity, createIdempotencyKey: () => SECOND_UUID })
    ).rejects.toThrow('disk full')
    expect(values.size).toBe(0)

    await expect(
      getOrCreateCodexResetAttempt({ ...identity, createIdempotencyKey: () => 'not-a-uuid' })
    ).rejects.toThrow(/idempotency key is invalid/)
  })

  it('never replaces a pending key based on age and clears only the matching authoritative attempt', async () => {
    const identity = { hostId: 'host-a', expectedScope: makeScope() }
    const createKey = vi.fn(() => FIRST_UUID)
    await getOrCreateCodexResetAttempt({ ...identity, createIdempotencyKey: createKey })

    const now = vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2036-01-01T00:00:00Z'))
    const oldAttempt = await getOrCreateCodexResetAttempt({
      ...identity,
      createIdempotencyKey: () => SECOND_UUID
    })
    now.mockRestore()
    expect(oldAttempt.idempotencyKey).toBe(FIRST_UUID)

    await expect(
      clearCodexResetAttemptAfterAuthoritativeResponse({
        ...identity,
        idempotencyKey: SECOND_UUID
      })
    ).rejects.toThrow(/identity changed/)
    expect(values.size).toBe(1)

    await clearCodexResetAttemptAfterAuthoritativeResponse({
      ...identity,
      idempotencyKey: FIRST_UUID
    })
    expect(values.size).toBe(0)
  })
})
