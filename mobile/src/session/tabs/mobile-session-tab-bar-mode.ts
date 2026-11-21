import { readMirroredStorage } from '../../storage/mirrored-storage-keys'
import { LAST_VISITED_WORKTREE_STORAGE_KEY } from '../../worktree/navigation/last-visited-worktree-repo'

export type MobileSessionTabBarMode = 'classic-strip' | 'single-tab'
export const DEFAULT_MOBILE_SESSION_TAB_BAR_MODE: MobileSessionTabBarMode = 'single-tab'

export type MobileSessionTabsSheetScope = 'recent' | 'workspace'
export const DEFAULT_MOBILE_SESSION_TABS_SHEET_SCOPE: MobileSessionTabsSheetScope = 'recent'

const MODE_KEYS = ['orca:recent-session-cards', LAST_VISITED_WORKTREE_STORAGE_KEY] as const

let modeMemory: MobileSessionTabBarMode | null = null
let tabsSheetScopeMemory: MobileSessionTabsSheetScope | null = null

export function parseMobileSessionTabBarMode(
  raw: string | null | undefined
): MobileSessionTabBarMode | null {
  if (!raw) {
    return null
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || !('tabBarMode' in parsed)) {
      return null
    }
    return parsed.tabBarMode === 'classic-strip' || parsed.tabBarMode === 'single-tab'
      ? parsed.tabBarMode
      : null
  } catch {
    return null
  }
}

export function parseMobileSessionTabsSheetScope(
  raw: string | null | undefined
): MobileSessionTabsSheetScope | null {
  if (!raw) {
    return null
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || !('tabsSheetScope' in parsed)) {
      return null
    }
    return parsed.tabsSheetScope === 'recent' || parsed.tabsSheetScope === 'workspace'
      ? parsed.tabsSheetScope
      : null
  } catch {
    return null
  }
}

/** Reads the cached or mirrored session tab bar mode without triggering async I/O. */
export function getCachedMobileSessionTabBarMode(): MobileSessionTabBarMode {
  const mirrored = modeMemory === null ? readMirroredStorage(MODE_KEYS) : null
  modeMemory ??=
    parseMobileSessionTabBarMode(mirrored?.['orca:recent-session-cards']) ??
    parseMobileSessionTabBarMode(mirrored?.[LAST_VISITED_WORKTREE_STORAGE_KEY])
  return modeMemory ?? DEFAULT_MOBILE_SESSION_TAB_BAR_MODE
}

export function setCachedMobileSessionTabBarMode(mode: MobileSessionTabBarMode): void {
  modeMemory = mode
}

/** Reads the cached or mirrored tabs sheet scope without triggering async I/O. */
export function getCachedMobileSessionTabsSheetScope(): MobileSessionTabsSheetScope {
  const mirrored = tabsSheetScopeMemory === null ? readMirroredStorage(MODE_KEYS) : null
  tabsSheetScopeMemory ??=
    parseMobileSessionTabsSheetScope(mirrored?.['orca:recent-session-cards']) ??
    parseMobileSessionTabsSheetScope(mirrored?.[LAST_VISITED_WORKTREE_STORAGE_KEY])
  return tabsSheetScopeMemory ?? DEFAULT_MOBILE_SESSION_TABS_SHEET_SCOPE
}

export function setCachedMobileSessionTabsSheetScope(scope: MobileSessionTabsSheetScope): void {
  tabsSheetScopeMemory = scope
}

export function hydrateSessionTabPreferencesFromRaw(
  primaryRaw: string | null | undefined,
  fallbackRaw: string | null | undefined
): boolean {
  const storedMode =
    parseMobileSessionTabBarMode(primaryRaw) ?? parseMobileSessionTabBarMode(fallbackRaw)
  const storedScope =
    parseMobileSessionTabsSheetScope(primaryRaw) ?? parseMobileSessionTabsSheetScope(fallbackRaw)
  modeMemory ??= storedMode
  tabsSheetScopeMemory ??= storedScope
  return storedMode !== null || storedScope !== null
}

export function resetMobileSessionTabBarModeForTests(): void {
  modeMemory = null
  tabsSheetScopeMemory = null
}

/** Builds the serialized `orca:recent-session-cards` payload preserving legacy array format when defaults hold. */
export function serializeRecentSessionCardsPayload(
  cards: readonly unknown[],
  maxDisplay: number,
  defaultMaxDisplay: number,
  tabBarMode: MobileSessionTabBarMode,
  tabsSheetScope: MobileSessionTabsSheetScope = DEFAULT_MOBILE_SESSION_TABS_SHEET_SCOPE
): string {
  const customLimit = maxDisplay !== defaultMaxDisplay
  const customMode = tabBarMode !== DEFAULT_MOBILE_SESSION_TAB_BAR_MODE
  const customScope = tabsSheetScope !== DEFAULT_MOBILE_SESSION_TABS_SHEET_SCOPE
  if (!customLimit && !customMode && !customScope) {
    return JSON.stringify(cards)
  }
  return JSON.stringify({
    recentCards: cards,
    ...(customLimit ? { maxDisplay } : {}),
    ...(customMode ? { tabBarMode } : {}),
    ...(customScope ? { tabsSheetScope } : {})
  })
}
