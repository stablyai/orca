import {
  persistMirrored,
  readMirroredKeyOrStore,
  readMirroredStorage
} from '../storage/mirrored-storage-keys'
import {
  LAST_VISITED_WORKTREE_STORAGE_KEY,
  readLastVisitedWorktreeRecord
} from '../worktree/last-visited-worktree-repo'
import type { MobileSessionTab, MobileSessionTabType } from './mobile-session-route-types'
import {
  getMobileSessionTabTitle,
  resolveMobileTerminalTabAgentId
} from './mobile-terminal-tab-agent'

export const RECENT_SESSION_CARDS_STORAGE_KEY = 'orca:recent-session-cards'
export const MIN_RECENT_SESSION_CARDS_DISPLAY = 1
export const MAX_RECENT_SESSION_CARDS_DISPLAY = 7
export const MAX_RECENT_SESSION_CARDS_LIMIT = 20
export const MAX_RECENT_SESSION_CARDS_STORED = 20
const MAX_TOTAL = 40
const M_KEYS = [RECENT_SESSION_CARDS_STORAGE_KEY, LAST_VISITED_WORKTREE_STORAGE_KEY] as const
const TAB_TYPES = new Set<string>(['terminal', 'markdown', 'file', 'browser', 'agent-session'])

export type RecentSessionCardRecord = {
  hostId: string
  worktreeId: string
  worktreeName: string
  tabId: string
  leafId?: string
  terminalHandle?: string
  title: string
  tabType: MobileSessionTabType
  agentId?: string
  lastVisitedAt: number
}

type Cards = RecentSessionCardRecord[]
type ReadonlyCards = readonly RecentSessionCardRecord[]
type IdTab = { id: string; terminal?: string | null }
type LiveWorktree = { worktreeId: string; displayName?: string; isArchived?: boolean }

let memory: Cards | null = null
let maxDisplayMemory: number | null = null
let hydrated = false
const listeners = new Set<() => void>()

export const subscribeRecentSessionCards = (l: () => void): (() => void) => (
  listeners.add(l),
  () => void listeners.delete(l)
)

const notify = () => listeners.forEach((l) => l())
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null
const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.length > 0 ? v : undefined
const cardKey = (c: RecentSessionCardRecord): string => `${c.hostId}\0${c.worktreeId}\0${c.tabId}`
const matchesTab = (c: RecentSessionCardRecord, t: IdTab): boolean =>
  t.id === c.tabId || (Boolean(c.terminalHandle) && t.terminal === c.terminalHandle)
const clampLimit = (n: number): number =>
  Math.min(
    MAX_RECENT_SESSION_CARDS_LIMIT,
    Math.max(MIN_RECENT_SESSION_CARDS_DISPLAY, Math.round(n))
  )

function parseJson(raw: string | null | undefined): unknown {
  try {
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

function parseMaxDisplay(raw: string | null | undefined): number | null {
  const p = parseJson(raw)
  const v = isRecord(p) ? (p.maxDisplay ?? p.recentCardsMaxDisplay) : null
  return typeof v === 'number' && Number.isFinite(v) ? clampLimit(v) : null
}

export function getRecentSessionCardsMaxDisplaySync(): number {
  const m = maxDisplayMemory === null ? readMirroredStorage(M_KEYS) : null
  maxDisplayMemory ??=
    parseMaxDisplay(m?.[RECENT_SESSION_CARDS_STORAGE_KEY]) ??
    parseMaxDisplay(m?.[LAST_VISITED_WORKTREE_STORAGE_KEY])
  return maxDisplayMemory ?? MAX_RECENT_SESSION_CARDS_DISPLAY
}

export function setRecentSessionCardsMaxDisplay(limit: number): number {
  const current = readAllRecentSessionCardsSync()
  maxDisplayMemory = clampLimit(limit)
  persistCards(current, current[0] ?? { hostId: '', worktreeId: '' })
  return maxDisplayMemory
}

function parseCard(v: unknown): RecentSessionCardRecord | null {
  if (!isRecord(v) || typeof v.tabType !== 'string' || !TAB_TYPES.has(v.tabType)) {
    return null
  }
  const [h, w, id, t] = [str(v.hostId), str(v.worktreeId), str(v.tabId), str(v.title)]
  if (!h || !w || !id || !t || !Number.isFinite(v.lastVisitedAt)) {
    return null
  }
  const [leafId, terminalHandle, agentId] = [str(v.leafId), str(v.terminalHandle), str(v.agentId)]
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: guarded by TAB_TYPES.has(v.tabType) above.
  const tabType = v.tabType as MobileSessionTabType
  const base = { hostId: h, worktreeId: w, worktreeName: str(v.worktreeName) ?? '', tabId: id }
  const rest = { title: t, tabType, lastVisitedAt: Number(v.lastVisitedAt) }
  return Object.assign(
    base,
    rest,
    leafId && { leafId },
    terminalHandle && { terminalHandle },
    agentId && { agentId }
  )
}

export function parseRecentSessionCards(raw: string | null | undefined): Cards {
  const p = parseJson(raw)
  const items = Array.isArray(p)
    ? p
    : isRecord(p) && Array.isArray(p.recentCards)
      ? p.recentCards
      : []
  return items.flatMap((i) => {
    const c = parseCard(i)
    return c ? [c] : []
  })
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

function applyVisit(existing: ReadonlyCards, record: RecentSessionCardRecord): Cards {
  const key = cardKey(record)
  const rank = existing
    .filter((i) => i.hostId === record.hostId)
    .findIndex((i) => cardKey(i) === key)
  return rank !== -1 && rank < getRecentSessionCardsMaxDisplaySync()
    ? existing.map((i) => (cardKey(i) === key ? record : i))
    : capCards([record, ...existing.filter((i) => cardKey(i) !== key)])
}

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
  const storedLimit = parseMaxDisplay(dRaw) ?? parseMaxDisplay(lRaw)
  maxDisplayMemory ??= storedLimit
  const stored = capCards(
    mergeByRecency(parseRecentSessionCards(dRaw), parseRecentSessionCards(lRaw))
  )
  if (memory !== null) {
    const combined = memory.reduceRight((acc, visit) => applyVisit(acc, visit), stored)
    hydrated = true
    memory = combined
    return combined[0] ? persistCards(combined, combined[0]).slice() : (notify(), combined.slice())
  }
  hydrated = true
  memory = stored.length > 0 ? stored : memory
  if (stored.length > 0 || storedLimit !== null) {
    notify()
  }
  return stored.slice()
}

function persistCards(next: Cards, fallback: { hostId: string; worktreeId: string }): Cards {
  const maxDisplay = getRecentSessionCardsMaxDisplaySync()
  const custom = maxDisplay !== MAX_RECENT_SESSION_CARDS_DISPLAY
  memory = next
  notify()
  const dRaw = custom ? JSON.stringify({ recentCards: next, maxDisplay }) : JSON.stringify(next)
  void persistMirrored(RECENT_SESSION_CARDS_STORAGE_KEY, dRaw).catch(() => {})
  const last = readLastVisitedWorktreeRecord(
    readMirroredStorage(M_KEYS)[LAST_VISITED_WORKTREE_STORAGE_KEY] ?? null
  )
  const hostId = last?.hostId || fallback.hostId
  const worktreeId = last?.worktreeId || fallback.worktreeId
  if (hostId && worktreeId) {
    const extra = custom ? { recentCardsMaxDisplay: maxDisplay } : {}
    const lRaw = JSON.stringify({ hostId, worktreeId, recentCards: next, ...extra })
    void persistMirrored(LAST_VISITED_WORKTREE_STORAGE_KEY, lRaw).catch(() => {})
  }
  return next
}

export function recordRecentSessionCardVisit(r: RecentSessionCardRecord): Cards {
  if (!r.hostId || !r.worktreeId || !r.tabId) {
    return readAllRecentSessionCardsSync()
  }
  const next = applyVisit(readAllRecentSessionCardsSync(), r)
  if (hydrated) {
    return persistCards(next, r)
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
  const current = readAllRecentSessionCardsSync()
  const scoped = tabId != null || handle != null
  const next = current.filter(
    (i) =>
      i.hostId !== hostId ||
      i.worktreeId !== worktreeId ||
      (scoped && (tabId == null || i.tabId !== tabId) && (!handle || i.terminalHandle !== handle))
  )
  return next.length === current.length ? current : persistCards(next, { hostId, worktreeId })
}

export function reconcileRecentSessionCardsForWorktree(p: {
  hostId: string
  worktreeId: string
  liveTabs: readonly IdTab[]
  allowEmpty?: boolean
}): Cards {
  const current = readAllRecentSessionCardsSync()
  if (!p.hostId || !p.worktreeId || (!p.liveTabs.length && !p.allowEmpty)) {
    return current
  }
  const next = current.filter(
    (i) =>
      i.hostId !== p.hostId ||
      i.worktreeId !== p.worktreeId ||
      p.liveTabs.some((t) => matchesTab(i, t))
  )
  return next.length === current.length ? current : persistCards(next, p)
}

export const clearRecentSessionCardsForTests = (): void => {
  memory = null
  maxDisplayMemory = null
  hydrated = false
}

export function getVisibleRecentSessionCards(p: {
  hostId: string
  currentWorktreeId: string
  currentTabId: string | null
  limit?: number
  liveWorktrees?: readonly LiveWorktree[]
  currentWorktreeTabs?: readonly IdTab[]
}): Cards {
  const live = p.liveWorktrees?.length
    ? new Map(p.liveWorktrees.map((w) => [w.worktreeId, w]))
    : null
  const tabs = p.currentWorktreeTabs
  return readAllRecentSessionCardsSync()
    .filter((i) => {
      const entry = live?.get(i.worktreeId)
      const closed =
        Boolean(tabs?.length) &&
        i.worktreeId === p.currentWorktreeId &&
        !tabs?.some((t) => matchesTab(i, t))
      return i.hostId === p.hostId && (!live || (entry && entry.isArchived !== true)) && !closed
    })
    .slice(0, p.limit ?? getRecentSessionCardsMaxDisplaySync())
    .map((i) => ({ ...i, worktreeName: live?.get(i.worktreeId)?.displayName || i.worktreeName }))
}

export function buildRecentSessionCardFromTab(p: {
  hostId: string
  worktreeId: string
  worktreeName: string
  tab: MobileSessionTab
  now?: number
}): RecentSessionCardRecord {
  const { hostId, worktreeId, worktreeName, tab: t } = p
  const agentId =
    t.type === 'agent-session'
      ? t.agent
      : t.type === 'terminal'
        ? resolveMobileTerminalTabAgentId(t)
        : undefined
  const [leafId, terminalHandle] = t.type === 'terminal' ? [str(t.leafId), str(t.terminal)] : []
  const base = { hostId, worktreeId, worktreeName, tabId: t.id, title: getMobileSessionTabTitle(t) }
  const rest = { tabType: t.type, lastVisitedAt: p.now ?? Date.now() }
  return Object.assign(
    base,
    rest,
    agentId && { agentId },
    leafId && { leafId },
    terminalHandle && { terminalHandle }
  )
}
