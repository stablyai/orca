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
import type { ExecutionHostId } from '../../../src/shared/execution-host/execution-host'
import {
  buildRecentSessionCardFromTab,
  recentCardExecutionHostKey,
  type LiveRecentCardTab,
  type RecentSessionCardSnapshot
} from './recent-session-card-snapshot'
import {
  capRecentCardList,
  dedupeRecentSessionCards,
  filterVisibleRecentSessionCards,
  mergeRecentCardListsByRecency,
  reconcileRecentSessionCardList,
  type LiveRecentCardWorktree
} from './recent-session-card-visibility'
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
type PendingRemoval = {
  hostId: string
  executionHost?: ExecutionHostId
  worktreeId: string
  tabId?: string
  handle?: string
}

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
const removalDrops = (i: RecentSessionCardRecord, r: PendingRemoval): boolean =>
  i.hostId === r.hostId &&
  i.worktreeId === r.worktreeId &&
  recentCardExecutionHostKey(i.executionHost) === recentCardExecutionHostKey(r.executionHost) &&
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

const applyVisit = (existing: ReadonlyCards, record: RecentSessionCardRecord): Cards =>
  capRecentCardList(
    dedupeRecentSessionCards([record, ...existing]),
    MAX_RECENT_SESSION_CARDS_STORED,
    MAX_TOTAL
  )

export function readAllRecentSessionCardsSync(): Cards {
  if (!memory) {
    const m = readMirroredStorage(M_KEYS)
    const d = parseRecentSessionCards(m[RECENT_SESSION_CARDS_STORAGE_KEY])
    const cards = dedupeRecentSessionCards(
      d.length ? d : parseRecentSessionCards(m[LAST_VISITED_WORKTREE_STORAGE_KEY])
    )
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
  const [dParsed, lParsed] = [parseRecentSessionCards(dRaw), parseRecentSessionCards(lRaw)]
  const merged = mergeRecentCardListsByRecency(dParsed, lParsed)
  const stored = capRecentCardList(
    withoutPendingRemovals(merged),
    MAX_RECENT_SESSION_CARDS_STORED,
    MAX_TOTAL
  )
  pendingRemovals.length = 0
  if (memory !== null) {
    const combined = memory.reduceRight((acc, visit) => applyVisit(acc, visit), stored)
    hydrated = true
    memory = combined
    return combined[0] ? persistCards(combined).slice() : (notify(), combined.slice())
  }
  hydrated = true
  if (stored.length < Math.max(dParsed.length, lParsed.length)) {
    return persistCards(stored).slice()
  }
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
  handle?: string | null,
  executionHost?: ExecutionHostId
): Cards {
  const execKey = recentCardExecutionHostKey(executionHost)
  if (!hydrated) {
    const [tid, hdl] = [str(tabId), str(handle)]
    pendingRemovals.push(
      Object.assign(
        { hostId, worktreeId },
        executionHost && { executionHost },
        tid && { tabId: tid },
        hdl && { handle: hdl }
      )
    )
  }
  const current = readAllRecentSessionCardsSync()
  const scoped = tabId != null || handle != null
  const next = current.filter(
    (i) =>
      i.hostId !== hostId ||
      i.worktreeId !== worktreeId ||
      recentCardExecutionHostKey(i.executionHost) !== execKey ||
      (scoped && (tabId == null || i.tabId !== tabId) && (!handle || i.terminalHandle !== handle))
  )
  if (next.length === current.length) {
    return current
  }
  if (!hydrated) {
    memory = next
    notify()
    return next.slice()
  }
  return persistCards(next)
}

export function reconcileRecentSessionCardsForWorktree(p: {
  hostId: string
  worktreeId: string
  executionHost?: ExecutionHostId
  liveTabs: readonly LiveRecentCardTab[]
  allowEmpty?: boolean
}): Cards {
  const current = readAllRecentSessionCardsSync()
  if (!p.hostId || !p.worktreeId || (!p.liveTabs.length && !p.allowEmpty)) {
    return current
  }
  const { next, changed } = reconcileRecentSessionCardList(current, p)
  if (!changed) {
    return current
  }
  if (!hydrated) {
    memory = next
    notify()
    return next.slice()
  }
  return persistCards(next)
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
  currentExecutionHost?: ExecutionHostId
  currentTabId: string | null
  limit?: number
  liveWorktrees?: readonly LiveRecentCardWorktree[]
  confirmedExecutionHosts?: ReadonlySet<string>
  currentWorktreeTabs?: readonly LiveRecentCardTab[]
}): Cards {
  return filterVisibleRecentSessionCards(readAllRecentSessionCardsSync(), {
    ...p,
    limit: p.limit ?? getRecentSessionCardsMaxDisplaySync()
  })
}
