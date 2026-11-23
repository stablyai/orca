import { expect, it } from 'vitest'
import { spendAzureDevOpsPrWrite } from './pr-review-write-budget'

it('counts writes per kind per day and refuses past the limit, resetting on a new day', () => {
  const limits = { comment: 2, vote: 1 }
  const first = spendAzureDevOpsPrWrite(null, 'comment', '2026-11-23', limits)
  const second = spendAzureDevOpsPrWrite(first, 'comment', '2026-11-23', limits)
  expect(second).toEqual({ day: '2026-11-23', comment: 2, vote: 0 })
  expect(spendAzureDevOpsPrWrite(second, 'comment', '2026-11-23', limits)).toBeNull()
  expect(spendAzureDevOpsPrWrite(second, 'vote', '2026-11-23', limits)).toEqual({
    day: '2026-11-23',
    comment: 2,
    vote: 1
  })
  expect(spendAzureDevOpsPrWrite(second, 'comment', '2026-11-24', limits)).toEqual({
    day: '2026-11-24',
    comment: 1,
    vote: 0
  })
  // A hand-edited or corrupt file never grants extra writes.
  expect(
    spendAzureDevOpsPrWrite(
      { day: '2026-11-23', comment: Number.NaN, vote: -5 },
      'vote',
      '2026-11-23',
      limits
    )
  ).toEqual({ day: '2026-11-23', comment: 0, vote: 1 })
})
