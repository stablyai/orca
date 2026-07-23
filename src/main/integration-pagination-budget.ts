import {
  JsonStringifyByteLimitError,
  stringifyJsonWithinByteLimit
} from '../shared/node-bounded-json-stringify'

export const INTEGRATION_PAGINATION_MAX_PAGES = 100
export const INTEGRATION_PAGINATION_MAX_ITEMS = 10_000
export const INTEGRATION_PAGINATION_MAX_RETAINED_BYTES = 32 * 1024 * 1024

export type IntegrationPaginationLimits = {
  maxPages: number
  maxItems: number
  maxRetainedBytes: number
}

const DEFAULT_LIMITS: IntegrationPaginationLimits = {
  maxPages: INTEGRATION_PAGINATION_MAX_PAGES,
  maxItems: INTEGRATION_PAGINATION_MAX_ITEMS,
  maxRetainedBytes: INTEGRATION_PAGINATION_MAX_RETAINED_BYTES
}

export class IntegrationPaginationLimitError extends Error {
  constructor() {
    super('Integration pagination exceeded its retained result budget.')
    this.name = 'IntegrationPaginationLimitError'
  }
}

export class IntegrationPaginationBudget {
  private pages = 0
  private items = 0
  private retainedBytes = 0

  constructor(private readonly limits: IntegrationPaginationLimits = DEFAULT_LIMITS) {}

  admitPage(pageItems: readonly unknown[]): boolean {
    if (
      this.pages >= this.limits.maxPages ||
      pageItems.length > this.limits.maxItems - this.items
    ) {
      return false
    }
    const pageBytes = this.measureWithinRemainingBudget(pageItems)
    if (pageBytes === null) {
      return false
    }
    this.pages += 1
    this.items += pageItems.length
    this.retainedBytes += pageBytes
    return true
  }

  assertCumulativePage(items: readonly unknown[]): void {
    if (this.pages >= this.limits.maxPages || items.length > this.limits.maxItems) {
      throw new IntegrationPaginationLimitError()
    }
    const measuredBytes = this.measureWithinTotalBudget(items)
    if (measuredBytes === null) {
      throw new IntegrationPaginationLimitError()
    }
    this.pages += 1
    this.items = items.length
    this.retainedBytes = measuredBytes
  }

  get canRequestPage(): boolean {
    return (
      this.pages < this.limits.maxPages &&
      this.items < this.limits.maxItems &&
      this.retainedBytes <= this.limits.maxRetainedBytes - 2
    )
  }

  private measureWithinRemainingBudget(value: unknown): number | null {
    const remaining = this.limits.maxRetainedBytes - this.retainedBytes
    try {
      return stringifyJsonWithinByteLimit(value, remaining).byteLength
    } catch (error) {
      if (error instanceof JsonStringifyByteLimitError) {
        return null
      }
      throw error
    }
  }

  private measureWithinTotalBudget(value: unknown): number | null {
    try {
      return stringifyJsonWithinByteLimit(value, this.limits.maxRetainedBytes).byteLength
    } catch (error) {
      if (error instanceof JsonStringifyByteLimitError) {
        return null
      }
      throw error
    }
  }
}
