/** Near-top offset that pages in older mobile chat history. */
export const MOBILE_CHAT_EARLIER_PAGE_TOP_PX = 60

export type MobileEarlierPageSample = {
  offsetY: number
  previousOffsetY: number | null
  /** Oldest transcript row. Tail rows do not move it, so a count change is not growth. */
  historyHeadId: string | null
  requestedAtHistoryHeadId: string | null
  hasRequested: boolean
  hasMore: boolean
  loadingEarlier: boolean
}

/**
 * One earlier page per visible stretch. A prepend leaves the numeric offset
 * near the top, so a later scroll event must not immediately request again.
 * Only a new oldest row unlocks the next page — a shorter list or a new tail
 * row is not older history.
 */
export function shouldRequestMobileEarlierPage(sample: MobileEarlierPageSample): boolean {
  if (!sample.hasMore || sample.loadingEarlier) {
    return false
  }
  if (sample.offsetY >= MOBILE_CHAT_EARLIER_PAGE_TOP_PX) {
    return false
  }
  if (sample.previousOffsetY !== null && sample.offsetY >= sample.previousOffsetY) {
    return false
  }
  return !sample.hasRequested || sample.historyHeadId !== sample.requestedAtHistoryHeadId
}

export function createMobileEarlierPageGate(): {
  observe(sample: {
    offsetY: number
    historyHeadId: string | null
    hasMore: boolean
    loadingEarlier: boolean
  }): boolean
} {
  let previousOffsetY: number | null = null
  let requestedAtHistoryHeadId: string | null = null
  let hasRequested = false
  return {
    observe(sample) {
      const should = shouldRequestMobileEarlierPage({
        ...sample,
        previousOffsetY,
        requestedAtHistoryHeadId,
        hasRequested
      })
      previousOffsetY = sample.offsetY
      if (should) {
        hasRequested = true
        requestedAtHistoryHeadId = sample.historyHeadId
      }
      return should
    }
  }
}
