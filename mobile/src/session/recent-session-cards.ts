import {
  persistMirrored,
  readMirroredKeyOrStore,
  readMirroredStorage
} from '../storage/mirrored-storage-keys'
import { PAGE_STORAGE_MAX_VALUE_CHARS } from '../mobile-web-shell/page-storage/page-storage-keys'
import { LAST_VISITED_WORKTREE_STORAGE_KEY } from '../worktree/navigation/last-visited-worktree-repo'
import { writeRecentCardsToLastVisitedWorktree } from '../worktree/navigation/last-visited-worktree-by-host'
import {
  DEFAULT_MOBILE_SESSION_TAB_BAR_MODE,
  DEFAULT_MOBILE_SESSION_TABS_SHEET_SCOPE,
  getCachedMobileSessionTabBarMode,
  getCachedMobileSessionTabsSheetScope,
  hydrateSessionTabPreferencesFromRaw,
  resetMobileSessionTabBarModeForTests,
  serializeRecentSessionCardsPayload,
  setCachedMobileSessionTabBarMode,
  setCachedMobileSessionTabsSheetScope,
  type MobileSessionTabBarMode,
  type MobileSessionTabsSheetScope
} from './tabs/mobile-session-tab-bar-mode'
import {
  buildRecentSessionCardFromTab,
  syncRecentCardWithLiveTab,
  type LiveRecentCardTab,
  type RecentSessionCardSnapshot
} from './recent-session-card-snapshot'
import {
  MAX_RECENT_SESSION_CARDS_DISPLAY,
  MAX_RECENT_SESSION_CARDS_LIMIT,
  MIN_RECENT_SESSION_CARDS_DISPLAY,
  clampRecentSessionCardsLimit,
  parseRecentSessionCards,
  parseRecentSessionCardsMaxDisplay
} from './recent-session-card-serialization'

export { buildRecentSessionCardFromTab, parseRecentSessionCards }
export {
  MAX_RECENT_SESSION_CARDS_DISPLAY,
  MAX_RECENT_SESSION_CARDS_LIMIT,
  MIN_RECENT_SESSION_CARDS_DISPLAY
}
export type RecentSessionCardRecord = RecentSessionCardSnapshot
export {
  DEFAULT_MOBILE_SESSION_TAB_BAR_MODE,
  DEFAULT_MOBILE_SESSION_TABS_SHEET_SCOPE,
  type MobileSessionTabBarMode,
  type MobileSessionTabsSheetScope
}
export const RECENT_SESSION_CARDS_STORAGE_KEY = 'orca:recent-session-cards'
export const MAX_RECENT_SESSION_CARDS_STORED = 20
const MAX_TOTAL = 40
const M_KEYS = [RECENT_SESSION_CARDS_STORAGE_KEY, LAST_VISITED_WORKTREE_STORAGE_KEY] as const

type Cards = RecentSessionCardRecord[]
type ReadonlyCards = readonly RecentSessionCardRecord[]
type LiveWorktree = { worktreeId: string; displayName?: string; isArchived?: boolean }
type PendingRemoval = { hostId: string; worktreeId: string; tabId?: string; handle?: string }

let memory: Cards | null = null
let maxDisplayMemory: number | null = null
let hydrated = false
const listeners = new Set<() => void>()
const pendingRemovals: PendingRemoval[] = []

export const subscribeRecentSessionCards = (l: () => void): (() => void) => (
  listeners.add(l),
  () => void listeners.delete(l)
)

const notify = () => listeners.forEach((l) => l())
const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.length > 0 ? v : undefined
const cardKey = (c: RecentSessionCardRecord): string => `${c.hostId}\0${c.worktreeId}\0${c.tabId}`
const matchesTab = (c: RecentSessionCardRecord, t: LiveRecentCardTab): boolean =>
  t.id === c.tabId || (Boolean(c.terminalHandle) && t.terminal === c.terminalHandle)
const removalDrops = (i: RecentSessionCardRecord, r: PendingRemoval): boolean =>
  i.hostId === r.hostId &&
  i.worktreeId === r.worktreeId &&
  ((r.tabId === undefined && r.handle === undefined) ||
    i.tabId === r.tabId ||
    (r.handle !== undefined && i.terminalHandle === r.handle))
const withoutPendingRemovals = (cards: ReadonlyCards): Cards =>
  cards.filter((i) => !pendingRemovals.some((r) => removalDrops(i, r)))

export const getMobileSessionTabBarModeSync = getCachedMobileSessionTabBarMode
export const getMobileSessionTabsSheetScopeSync = getCachedMobileSessionTabsSheetScope

export function setMobileSessionTabBarMode(mode: MobileSessionTabBarMode): MobileSessionTabBarMode {
  setCachedMobileSessionTabBarMode(mode)
  persistCards(readAllRecentSessionCardsSync())
  return mode
}

export function setMobileSessionTabsSheetScope(
  scope: MobileSessionTabsSheetScope
): MobileSessionTabsSheetScope {
  setCachedMobileSessionTabsSheetScope(scope)
  persistCards(readAllRecentSessionCardsSync())
  return scope
}

export function getRecentSessionCardsMaxDisplaySync(): number {
  const m = maxDisplayMemory === null ? readMirroredStorage(M_KEYS) : null
  maxDisplayMemory ??=
    parseRecentSessionCardsMaxDisplay(m?.[RECENT_SESSION_CARDS_STORAGE_KEY]) ??
    parseRecentSessionCardsMaxDisplay(m?.[LAST_VISITED_WORKTREE_STORAGE_KEY])
  return maxDisplayMemory ?? MAX_RECENT_SESSION_CARDS_DISPLAY
}

export function setRecentSessionCardsMaxDisplay(limit: number): number {
  const current = readAllRecentSessionCardsSync()
  maxDisplayMemory = clampRecentSessionCardsLimit(limit)
  persistCards(current)
  return maxDisplayMemory
}

function capCards(cards: ReadonlyCards): Cards {
  const perHost = new Map<string, number>()
  return cards
    .filter((i) => {
      const n = (perHost.get(i.hostId) ?? 0) + 1
      perHost.set(i.hostId, n)
      return n <= MAX_RECENT_SESSION_CARDS_STORED
    })
    .slice(0, MAX_TOTAL)
}

function mergeByRecency(primary: ReadonlyCards, secondary: ReadonlyCards): Cards {
  const byKey = new Map<string, RecentSessionCardRecord>()
  for (const c of [...secondary, ...primary]) {
    if ((byKey.get(cardKey(c))?.lastVisitedAt ?? -Infinity) <= c.lastVisitedAt) {
      byKey.set(cardKey(c), c)
    }
  }
  return [...byKey.values()].sort((a, b) => b.lastVisitedAt - a.lastVisitedAt)
}

const applyVisit = (existing: ReadonlyCards, record: RecentSessionCardRecord): Cards =>
  capCards([record, ...existing.filter((i) => cardKey(i) !== cardKey(record))])

export function readAllRecentSessionCardsSync(): Cards {
  if (!memory) {
    const m = readMirroredStorage(M_KEYS)
    const d = parseRecentSessionCards(m[RECENT_SESSION_CARDS_STORAGE_KEY])
    const cards = d.length ? d : parseRecentSessionCards(m[LAST_VISITED_WORKTREE_STORAGE_KEY])
    if (cards.length > 0) {
      memory = cards
      hydrated = true
    }
    return cards.slice()
  }
  return memory.slice()
}

export async function hydrateRecentSessionCards(): Promise<Cards> {
  const [dRaw, lRaw] = await Promise.all(M_KEYS.map((k) => readMirroredKeyOrStore(k)))
  const storedLimit =
    parseRecentSessionCardsMaxDisplay(dRaw) ?? parseRecentSessionCardsMaxDisplay(lRaw)
  maxDisplayMemory ??= storedLimit
  const storedPrefs = hydrateSessionTabPreferencesFromRaw(dRaw, lRaw)
  const merged = mergeByRecency(parseRecentSessionCards(dRaw), parseRecentSessionCards(lRaw))
  const stored = capCards(withoutPendingRemovals(merged))
  pendingRemovals.length = 0
  if (memory !== null) {
    const combined = memory.reduceRight((acc, visit) => applyVisit(acc, visit), stored)
    hydrated = true
    memory = combined
    return combined[0] ? persistCards(combined).slice() : (notify(), combined.slice())
  }
  hydrated = true
  memory = stored.length > 0 ? stored : memory
  if (stored.length > 0 || storedLimit !== null || storedPrefs) {
    notify()
  }
  return stored.slice()
}

const stripTransientCardFields = ({
  unread: _unread,
  ...rest
}: RecentSessionCardRecord): RecentSessionCardRecord => rest

function persistCards(next: Cards): Cards {
  const maxDisplay = getRecentSessionCardsMaxDisplaySync()
  const tabBarMode = getCachedMobileSessionTabBarMode()
  const tabsSheetScope = getCachedMobileSessionTabsSheetScope()
  // Keep live `unread` in memory only (K1); storage strips transient agent-attention verdicts.
  const persistedCards = next.map(stripTransientCardFields)
  const dedicatedCards = persistedCards.slice()
  const serialize = () =>
    serializeRecentSessionCardsPayload(
      dedicatedCards,
      maxDisplay,
      MAX_RECENT_SESSION_CARDS_DISPLAY,
      tabBarMode,
      tabsSheetScope
    )
  memory = next
  notify()
  let dRaw = serialize()
  while (dedicatedCards.length > 0 && dRaw.length > PAGE_STORAGE_MAX_VALUE_CHARS) {
    dedicatedCards.pop()
    dRaw = serialize()
  }
  void persistMirrored(RECENT_SESSION_CARDS_STORAGE_KEY, dRaw).catch(() => {})
  void writeRecentCardsToLastVisitedWorktree(persistedCards, {
    ...(maxDisplay !== MAX_RECENT_SESSION_CARDS_DISPLAY
      ? { recentCardsMaxDisplay: maxDisplay }
      : {}),
    ...(tabBarMode !== DEFAULT_MOBILE_SESSION_TAB_BAR_MODE ? { tabBarMode } : {}),
    ...(tabsSheetScope !== DEFAULT_MOBILE_SESSION_TABS_SHEET_SCOPE ? { tabsSheetScope } : {})
  })
  return next
}

export function recordRecentSessionCardVisit(r: RecentSessionCardRecord): Cards {
  if (!r.hostId || !r.worktreeId || !r.tabId) {
    return readAllRecentSessionCardsSync()
  }
  const next = applyVisit(readAllRecentSessionCardsSync(), r)
  if (hydrated) {
    return persistCards(next)
  }
  memory = next
  notify()
  void hydrateRecentSessionCards().catch(() => {})
  return next.slice()
}

export function removeRecentSessionCard(
  hostId: string,
  worktreeId: string,
  tabId?: string | null,
  handle?: string | null
): Cards {
  if (!hydrated) {
    const [tid, hdl] = [str(tabId), str(handle)]
    pendingRemovals.push(
      Object.assign({ hostId, worktreeId }, tid && { tabId: tid }, hdl && { handle: hdl })
    )
  }
  const current = readAllRecentSessionCardsSync()
  const scoped = tabId != null || handle != null
  const next = current.filter(
    (i) =>
      i.hostId !== hostId ||
      i.worktreeId !== worktreeId ||
      (scoped && (tabId == null || i.tabId !== tabId) && (!handle || i.terminalHandle !== handle))
  )
  return next.length === current.length ? current : persistCards(next)
}

export function reconcileRecentSessionCardsForWorktree(p: {
  hostId: string
  worktreeId: string
  liveTabs: readonly LiveRecentCardTab[]
  allowEmpty?: boolean
}): Cards {
  const current = readAllRecentSessionCardsSync()
  if (!p.hostId || !p.worktreeId || (!p.liveTabs.length && !p.allowEmpty)) {
    return current
  }
  let changed = false
  const next = current.flatMap((i) => {
    if (i.hostId !== p.hostId || i.worktreeId !== p.worktreeId) {
      return [i]
    }
    const match = p.liveTabs.find((t) => matchesTab(i, t))
    const updated = match ? syncRecentCardWithLiveTab(i, match) : null
    changed ||= updated !== i
    return updated ? [updated] : []
  })
  return changed ? persistCards(next) : current
}

export const clearRecentSessionCardsForTests = (): void => {
  memory = null
  maxDisplayMemory = null
  resetMobileSessionTabBarModeForTests()
  hydrated = false
  pendingRemovals.length = 0
}

export function getVisibleRecentSessionCards(p: {
  hostId: string
  currentWorktreeId: string
  currentTabId: string | null
  limit?: number
  liveWorktrees?: readonly LiveWorktree[]
  currentWorktreeTabs?: readonly LiveRecentCardTab[]
}): Cards {
  const live = p.liveWorktrees?.length
    ? new Map(p.liveWorktrees.map((w) => [w.worktreeId, w]))
    : null
  const tabs = p.currentWorktreeTabs
  return readAllRecentSessionCardsSync()
    .filter((i) => {
      const inCurrent = i.worktreeId === p.currentWorktreeId
      const isCurrent = Boolean(p.currentTabId) && inCurrent && i.tabId === p.currentTabId
      const closed = Boolean(tabs?.length) && inCurrent && !tabs?.some((t) => matchesTab(i, t))
      const activeWt =
        !live || Boolean(live.get(i.worktreeId) && !live.get(i.worktreeId)?.isArchived)
      return i.hostId === p.hostId && !isCurrent && activeWt && !closed
    })
    .slice(0, p.limit ?? getRecentSessionCardsMaxDisplaySync())
    .map((i) => {
      const match =
        i.worktreeId === p.currentWorktreeId ? tabs?.find((t) => matchesTab(i, t)) : undefined
      const synced = syncRecentCardWithLiveTab(i, match)
      return {
        ...synced,
        worktreeName: live?.get(i.worktreeId)?.displayName || synced.worktreeName
      }
    })
}
