import {
  MOBILE_WEB_SESSION_EVENT_MAX_BYTES,
  type MobileWebSessionTab
} from '../../../src/shared/mobile-web/bridge-operation-contract'

/**
 * The tab count and the event byte cap govern the same snapshot, and only the count degraded: a
 * workspace whose tabs serialize past the cap while still under 200 tabs used to kill its
 * subscription, with no frame the page could see. Drop tabs to fit and report it through the
 * `truncated` flag the count limit already uses.
 */
export function tabsWithinMobileWebSessionEventBudget(
  envelope: Record<string, unknown>,
  tabs: MobileWebSessionTab[]
): MobileWebSessionTab[] {
  const budget =
    MOBILE_WEB_SESSION_EVENT_MAX_BYTES -
    encodedByteLength({ ...envelope, tabs: [], truncated: false })
  if (budget < 0) {
    return []
  }
  const sizes = tabs.map((tab) => encodedByteLength(tab))
  const separators = Math.max(tabs.length - 1, 0)
  if (sizes.reduce((total, size) => total + size, 0) + separators <= budget) {
    return tabs
  }
  const kept = new Set<number>()
  let used = 0
  // Why first: the tab the screen is showing must survive, even behind a long prefix of large ones.
  const activeIndex = tabs.findIndex((tab) => tab.isActive)
  if (activeIndex !== -1 && sizes[activeIndex] <= budget) {
    kept.add(activeIndex)
    used = sizes[activeIndex]
  }
  for (let index = 0; index < tabs.length; index += 1) {
    if (kept.has(index)) {
      continue
    }
    const next = used + sizes[index] + (kept.size > 0 ? 1 : 0)
    if (next <= budget) {
      kept.add(index)
      used = next
    }
  }
  return tabs.filter((_, index) => kept.has(index))
}

export function encodedByteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength
}
