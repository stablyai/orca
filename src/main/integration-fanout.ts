import { MAX_INTEGRATION_ACCOUNTS } from './integration-account-persistence-limits'
import {
  INTEGRATION_PAGINATION_MAX_ITEMS,
  INTEGRATION_PAGINATION_MAX_RETAINED_BYTES,
  IntegrationPaginationBudget,
  type IntegrationPaginationLimits
} from './integration-pagination-budget'

export const INTEGRATION_FANOUT_MAX_CONCURRENT = 4

const DEFAULT_FANOUT_LIMITS: IntegrationPaginationLimits = {
  maxPages: MAX_INTEGRATION_ACCOUNTS,
  maxItems: INTEGRATION_PAGINATION_MAX_ITEMS,
  maxRetainedBytes: INTEGRATION_PAGINATION_MAX_RETAINED_BYTES
}

export function createIntegrationFanoutBudget(): IntegrationPaginationBudget {
  return new IntegrationPaginationBudget(DEFAULT_FANOUT_LIMITS)
}

export async function runBoundedIntegrationFanout<TEntry, TResult>(
  entries: readonly TEntry[],
  load: (entry: TEntry, index: number) => Promise<TResult>,
  retainedValues: (result: TResult) => readonly unknown[],
  options: {
    budget?: IntegrationPaginationBudget
    maxConcurrent?: number
    limits?: IntegrationPaginationLimits
  } = {}
): Promise<{ results: TResult[]; truncated: boolean; attemptedCount: number }> {
  const maxConcurrent = options.maxConcurrent ?? INTEGRATION_FANOUT_MAX_CONCURRENT
  if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent <= 0) {
    throw new RangeError('Integration fan-out concurrency must be a positive safe integer')
  }

  const budget =
    options.budget ?? new IntegrationPaginationBudget(options.limits ?? DEFAULT_FANOUT_LIMITS)
  const results: TResult[] = []
  let attemptedCount = 0
  for (let offset = 0; offset < entries.length; offset += maxConcurrent) {
    const batch = entries.slice(offset, offset + maxConcurrent)
    attemptedCount += batch.length
    const loaded = await Promise.all(
      batch.map((entry, batchIndex) => load(entry, offset + batchIndex))
    )
    for (const result of loaded) {
      if (!budget.admitPage(retainedValues(result))) {
        return { results, truncated: true, attemptedCount }
      }
      results.push(result)
    }
    if (!budget.canRequestPage && offset + batch.length < entries.length) {
      return { results, truncated: true, attemptedCount }
    }
  }
  return { results, truncated: false, attemptedCount }
}

export function runBoundedIntegrationSettledFanout<TEntry, TResult>(
  entries: readonly TEntry[],
  load: (entry: TEntry, index: number) => Promise<TResult>,
  retainedValues: (result: TResult) => readonly unknown[]
): Promise<{
  results: PromiseSettledResult<TResult>[]
  truncated: boolean
  attemptedCount: number
}> {
  return runBoundedIntegrationFanout(
    entries,
    async (entry, index): Promise<PromiseSettledResult<TResult>> => {
      try {
        return { status: 'fulfilled', value: await load(entry, index) }
      } catch (reason) {
        return { status: 'rejected', reason }
      }
    },
    (result) =>
      result.status === 'fulfilled'
        ? retainedValues(result.value)
        : [result.reason instanceof Error ? result.reason.message : String(result.reason)]
  )
}
