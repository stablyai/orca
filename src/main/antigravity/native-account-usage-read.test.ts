import { expect, it } from 'vitest'
import type { ProviderRateLimits } from '../../shared/rate-limit-types'
import { credential, harness, refreshedWithoutIdToken } from './native-account-test-fixtures'

function reading(usedPercent: number, updatedAt: number): ProviderRateLimits {
  return {
    provider: 'antigravity',
    session: null,
    weekly: { usedPercent, windowMinutes: 10080, resetsAt: null, resetDescription: null },
    updatedAt,
    error: null,
    status: 'ok'
  }
}

it('keeps each saved account’s last reading with its read time after agy switches', async () => {
  const h = harness()
  const a = (await h.service.addCurrentAccount()).activeAccountId!
  h.setNative(credential('b', 2))
  const b = (await h.service.addCurrentAccount()).activeAccountId!
  await h.service.selectAccount(a)

  const start = await h.service.beginUsageRead()
  expect(start?.accounts.map((entry) => [entry.accountId, entry.rateLimits])).toEqual([
    [a, null],
    [b, null]
  ])
  // agy refreshes its token mid-read, dropping the id_token; the login is unchanged.
  h.setNative(refreshedWithoutIdToken(2))
  const finish = await h.service.finishUsageRead(start!.login!, reading(40, 1_000))
  expect(finish).toMatchObject({ switched: false, account: { id: a } })

  await h.service.selectAccount(b)
  const state = await h.service.listAccounts()
  expect(state.accounts.map((account) => [account.id, account.usage?.updatedAt ?? null])).toEqual([
    [a, 1_000],
    [b, null]
  ])
})

it('drops a reading when agy switched accounts during the read', async () => {
  const h = harness()
  const a = (await h.service.addCurrentAccount()).activeAccountId!
  h.setNative(credential('b', 2))
  await h.service.addCurrentAccount()
  await h.service.selectAccount(a)

  const start = await h.service.beginUsageRead()
  h.setNative(credential('b', 2))
  expect(await h.service.finishUsageRead(start!.login!, reading(40, 1_000))).toEqual({
    switched: true
  })
  expect(h.getVault().accounts.every((account) => !account.usage)).toBe(true)
})
