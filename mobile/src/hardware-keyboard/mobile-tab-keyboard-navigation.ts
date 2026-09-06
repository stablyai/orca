import type { MobileSessionTab } from '../session/mobile-session-route-types'

export type MobileTabCycleMode = 'all' | 'same-type' | 'terminal'

export function getRelativeKeyboardTab(options: {
  tabs: readonly MobileSessionTab[]
  activeTabId: string | null
  direction: -1 | 1
  mode: MobileTabCycleMode
}): MobileSessionTab | null {
  const active = options.tabs.find((tab) => tab.id === options.activeTabId)
  const candidates = options.tabs.filter((tab) => {
    if (options.mode === 'all') {
      return true
    }
    if (options.mode === 'terminal') {
      return tab.type === 'terminal'
    }
    return active ? tab.type === active.type : true
  })
  if (candidates.length === 0) {
    return null
  }
  const currentIndex = candidates.findIndex((tab) => tab.id === options.activeTabId)
  if (currentIndex === -1) {
    return options.direction > 0 ? candidates[0]! : candidates[candidates.length - 1]!
  }
  if (candidates.length === 1) {
    return null
  }
  return (
    candidates[(currentIndex + options.direction + candidates.length) % candidates.length] ?? null
  )
}

export function getIndexedKeyboardTab(
  tabs: readonly MobileSessionTab[],
  oneBasedIndex: number
): MobileSessionTab | null {
  if (!Number.isInteger(oneBasedIndex) || oneBasedIndex < 1 || oneBasedIndex > 9) {
    return null
  }
  return tabs[oneBasedIndex - 1] ?? null
}

export class MobileRecentTabOrder {
  private ids: string[] = []

  record(tabId: string): void {
    this.ids = [...this.ids.filter((id) => id !== tabId), tabId]
  }

  previous(activeTabId: string | null, visibleTabIds: ReadonlySet<string>): string | null {
    const visible = this.ids.filter((id) => visibleTabIds.has(id))
    const activeIndex = activeTabId ? visible.lastIndexOf(activeTabId) : -1
    if (activeIndex > 0) {
      return visible[activeIndex - 1] ?? null
    }
    if (activeIndex === -1) {
      return visible[visible.length - 1] ?? null
    }
    return null
  }
}
