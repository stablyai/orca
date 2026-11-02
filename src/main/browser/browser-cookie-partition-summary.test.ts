import { expect, it } from 'vitest'
import { planImportWrites } from './browser-cookie-import-write'
import { summarizePartitionSkips } from './browser-cookie-partition-summary'

const readable = { status: 'unpartitioned' } as const
const unreadable = { status: 'unreadable', reason: 'synthetic incomplete partition' } as const

it('omits skip metadata when every cookie can be written', () => {
  expect(
    summarizePartitionSkips(
      planImportWrites([{ domain: 'example.com', partition: readable }]).skips
    )
  ).toEqual({})
})

it.each([false, true])(
  'counts unreadable and withheld cookies independently (reverse: %s)',
  (reverse) => {
    const cookies = [
      { domain: 'example.com', partition: readable },
      { domain: 'sub.example.com', partition: unreadable },
      { domain: 'other.example.net', partition: readable }
    ]
    const plan = planImportWrites(reverse ? cookies.toReversed() : cookies)
    expect(plan.writes).toHaveLength(1)
    expect(summarizePartitionSkips(plan.skips)).toEqual({
      partitionSkippedCookies: 2,
      partitionSkipBreakdown: { unreadableCookies: 1, preservedRelatedCookies: 1 }
    })
  }
)

it('does not count two unreadable cookies as related readable skips', () => {
  const plan = planImportWrites([
    { domain: 'example.com', partition: unreadable },
    { domain: 'sub.example.com', partition: unreadable }
  ])
  expect(summarizePartitionSkips(plan.skips)).toEqual({
    partitionSkippedCookies: 2,
    partitionSkipBreakdown: { unreadableCookies: 2, preservedRelatedCookies: 0 }
  })
})
