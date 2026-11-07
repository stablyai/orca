import AsyncStorage from '@react-native-async-storage/async-storage'
import type { AgentJournalSkillRef } from '../../../../../src/shared/agent-session/journal/agent-session-journal-types'
import {
  PAGE_STORAGE_MAX_VALUE_CHARS,
  workspaceScopedKey
} from '../../../mobile-web-shell/page-storage-keys'
import { readPageDeviceStore } from '../../../mobile-web-shell/bridge/page-device-store'
import { persistMirroredReadBack } from '../../../storage/mirrored-storage-keys'
import {
  deviceStoreDraftBackend,
  durableDraftRow,
  durableDraftRowKey,
  resetDurableDraftRowsForTests,
  type DurableDraftRow,
  type DurableDraftRowBackend
} from '../../../drafts/durable-draft-rows'

// Why this slot: every shell since 0.0.59 lets session pages keep it, and #37900 retired the terminal drafts it held.
// It is the store for shells without the device store, and older documents may still write it.
const LEGACY_PREFIX = 'orca:terminalDrafts:'

// Host paths only: a phone preview (data: or blob:) never outlives the page.
export type MobileNativeChatSavedImage = { path: string }
export type MobileNativeChatSavedFile = {
  name: string
  mime: string
  byteLength: number
  path: string
}

// A send whose clear was saved before its outcome was known; reopening keeps it or hands it back.
export type MobileNativeChatInFlightSend = {
  id: string
  kind: 'terminal' | 'structured'
  text: string
  skills: readonly AgentJournalSkillRef[]
  images: readonly MobileNativeChatSavedImage[]
  files: readonly MobileNativeChatSavedFile[]
  sessionId: string | null
  clientMessageId?: string
  normalizedText: string
  baselineTailMessageId: string | null
  queuedDuringWork?: boolean
  command?: boolean
}

export type MobileNativeChatSavedDraft = {
  text: string
  skills: readonly AgentJournalSkillRef[]
  skillOrigin?: string
  images: readonly MobileNativeChatSavedImage[]
  files: readonly MobileNativeChatSavedFile[]
  inFlight: readonly MobileNativeChatInFlightSend[]
}

export type MobileNativeChatDraftSource = {
  // Every scope's saveable draft; only tab scopes are kept.
  saved: () => Map<string, MobileNativeChatSavedDraft>
  // Puts back a saved draft unless the tab already holds user input.
  restore: (scope: string, draft: MobileNativeChatSavedDraft) => void
}

type Workspace = {
  hostId: string
  worktreeId: string
  row: DurableDraftRow
  // Retirements seen before the load lands; the load must not bring those tabs back.
  retainedTabs: ReadonlySet<string> | null
  closedTabs: Set<string>
}

const workspaces = new Map<string, Workspace>()
// Set by the draft store when it loads; nothing is read or saved before then.
let source: MobileNativeChatDraftSource | null = null

export function setMobileNativeChatDraftSource(next: MobileNativeChatDraftSource): void {
  source = next
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseList<T>(value: unknown, parse: (item: Record<string, unknown>) => T | null): T[] {
  return Array.isArray(value)
    ? value.flatMap((item) => {
        const parsed = isRecord(item) ? parse(item) : null
        return parsed === null ? [] : [parsed]
      })
    : []
}

const parseSkill = (skill: Record<string, unknown>): AgentJournalSkillRef | null =>
  typeof skill.name === 'string' && typeof skill.path === 'string'
    ? { name: skill.name, path: skill.path }
    : null

const parseImage = (image: Record<string, unknown>): MobileNativeChatSavedImage | null =>
  typeof image.path === 'string' && image.path !== '' ? { path: image.path } : null

const parseFile = (file: Record<string, unknown>): MobileNativeChatSavedFile | null =>
  typeof file.path === 'string' &&
  typeof file.name === 'string' &&
  typeof file.mime === 'string' &&
  typeof file.byteLength === 'number'
    ? { name: file.name, mime: file.mime, byteLength: file.byteLength, path: file.path }
    : null

function parseInFlight(send: Record<string, unknown>): MobileNativeChatInFlightSend | null {
  if (
    typeof send.id !== 'string' ||
    (send.kind !== 'terminal' && send.kind !== 'structured') ||
    typeof send.text !== 'string' ||
    typeof send.normalizedText !== 'string'
  ) {
    return null
  }
  return {
    id: send.id,
    kind: send.kind,
    text: send.text,
    skills: parseList(send.skills, parseSkill),
    images: parseList(send.images, parseImage),
    files: parseList(send.files, parseFile),
    sessionId: typeof send.sessionId === 'string' ? send.sessionId : null,
    ...(typeof send.clientMessageId === 'string' ? { clientMessageId: send.clientMessageId } : {}),
    normalizedText: send.normalizedText,
    baselineTailMessageId:
      typeof send.baselineTailMessageId === 'string' ? send.baselineTailMessageId : null,
    ...(send.queuedDuringWork === true ? { queuedDuringWork: true } : {}),
    ...(send.command === true ? { command: true } : {})
  }
}

// Anything else, including an older build's terminal drafts, reads as no drafts.
function parseSavedDrafts(value: unknown): Map<string, MobileNativeChatSavedDraft> {
  const saved = new Map<string, MobileNativeChatSavedDraft>()
  if (!isRecord(value) || !isRecord(value.chatDrafts)) {
    return saved
  }
  for (const [tabId, draft] of Object.entries(value.chatDrafts)) {
    if (!isRecord(draft) || typeof draft.text !== 'string') {
      continue
    }
    const parsed: MobileNativeChatSavedDraft = {
      text: draft.text,
      skills: parseList(draft.skills, parseSkill),
      skillOrigin: typeof draft.skillOrigin === 'string' ? draft.skillOrigin : undefined,
      images: parseList(draft.images, parseImage),
      files: parseList(draft.files, parseFile),
      inFlight: parseList(draft.inFlight, parseInFlight)
    }
    if (isSavedDraftKept(parsed)) {
      saved.set(tabId, parsed)
    }
  }
  return saved
}

export function isSavedDraftKept(draft: MobileNativeChatSavedDraft): boolean {
  return (
    draft.text !== '' ||
    draft.images.length > 0 ||
    draft.files.length > 0 ||
    draft.inFlight.length > 0
  )
}

function savedDraftsValue(drafts: ReadonlyMap<string, MobileNativeChatSavedDraft>): unknown {
  return drafts.size === 0 ? null : { chatDrafts: Object.fromEntries(drafts) }
}

// Drafts that would push the slot past the shell's cap stay in memory, so a refused write never leaves sent text stored.
function fitLegacySlot(drafts: ReadonlyMap<string, MobileNativeChatSavedDraft>): string | null {
  if (drafts.size === 0) {
    return null
  }
  const whole = JSON.stringify(savedDraftsValue(drafts))
  if (whole.length <= PAGE_STORAGE_MAX_VALUE_CHARS) {
    return whole
  }
  const kept: Record<string, MobileNativeChatSavedDraft> = {}
  for (const [tabId, draft] of drafts) {
    kept[tabId] = draft
    if (JSON.stringify({ chatDrafts: kept }).length > PAGE_STORAGE_MAX_VALUE_CHARS) {
      delete kept[tabId]
    }
  }
  return Object.keys(kept).length === 0 ? null : JSON.stringify({ chatDrafts: kept })
}

async function readLegacySlot(key: string): Promise<Map<string, MobileNativeChatSavedDraft>> {
  const raw = await AsyncStorage.getItem(key)
  try {
    return parseSavedDrafts(JSON.parse(raw ?? 'null'))
  } catch {
    return new Map()
  }
}

function legacyBackend(key: string): DurableDraftRowBackend {
  return {
    read: async () => {
      try {
        return { ok: true, value: savedDraftsValue(await readLegacySlot(key)) }
      } catch {
        return { ok: false }
      }
    },
    write: async (value) => {
      const fitted = fitLegacySlot(parseSavedDrafts(value))
      // Page stores can resolve a dropped write; reading back what stuck makes the next save retry it.
      return (await persistMirroredReadBack(key, fitted)) === fitted
    }
  }
}

// Each load imports the legacy slot (a document on an older build can write it again), store tabs winning, then deletes it.
function deviceStoreBackend(workspace: Workspace, legacyKey: string): DurableDraftRowBackend {
  const store = readPageDeviceStore()
  if (!store?.available()) {
    return legacyBackend(legacyKey)
  }
  const row = deviceStoreDraftBackend(store, workspace.row.key)
  return {
    read: async () => {
      const [stored, legacy] = await Promise.all([
        row.read(),
        readLegacySlot(legacyKey).catch(() => new Map<string, MobileNativeChatSavedDraft>())
      ])
      if (!stored.ok || legacy.size === 0) {
        return stored
      }
      const merged = new Map([...legacy, ...parseSavedDrafts(stored.value)])
      const value = savedDraftsValue(merged)
      if (await row.write(value)) {
        await persistMirroredReadBack(legacyKey, null)
      }
      return { ok: true, value }
    },
    write: row.write
  }
}

function workspaceFor(hostId: string, worktreeId: string): Workspace {
  const legacyKey = workspaceScopedKey(LEGACY_PREFIX, hostId, worktreeId)
  let workspace = workspaces.get(legacyKey)
  if (!workspace) {
    const created: Workspace = {
      hostId,
      worktreeId,
      retainedTabs: null,
      closedTabs: new Set(),
      row: durableDraftRow(durableDraftRowKey('chat', worktreeId, ''), {
        backend: () => deviceStoreBackend(created, legacyKey),
        snapshot: () => snapshot(created),
        restore: (value) => restore(created, value)
      })
    }
    workspace = created
    workspaces.set(legacyKey, workspace)
  }
  return workspace
}

// Only tab scopes (`host\0worktree\0tab`) are saved; queued-message edits stay in memory.
function tabOf(scope: string): { workspace: Workspace; tabId: string } | null {
  const [hostId, worktreeId, tabId, ...rest] = scope.split('\0')
  return hostId && worktreeId && tabId && rest.length === 0
    ? { workspace: workspaceFor(hostId, worktreeId), tabId }
    : null
}

function restore(workspace: Workspace, value: unknown): void {
  for (const [tabId, draft] of parseSavedDrafts(value)) {
    const live = workspace.retainedTabs?.has(tabId) ?? true
    if (live && !workspace.closedTabs.has(tabId)) {
      source?.restore(`${workspace.hostId}\0${workspace.worktreeId}\0${tabId}`, draft)
    }
  }
  workspace.retainedTabs = null
  workspace.closedTabs.clear()
}

function snapshot(workspace: Workspace): unknown {
  const drafts = new Map<string, MobileNativeChatSavedDraft>()
  for (const [scope, draft] of source?.saved() ?? []) {
    const tab = tabOf(scope)
    if (tab?.workspace === workspace) {
      drafts.set(tab.tabId, draft)
    }
  }
  return savedDraftsValue(drafts)
}

/** Restores a workspace's saved chat drafts once per page; later calls wait for that load. */
export function loadMobileNativeChatDrafts(hostId: string, worktreeId: string): Promise<void> {
  return workspaceFor(hostId, worktreeId).row.load()
}

/** Typing coalesces; clears save at once so a sent draft cannot come back. */
export function saveMobileNativeChatDraft(scope: string, timing: 'immediate' | 'deferred'): void {
  if (source) {
    tabOf(scope)?.workspace.row.save(timing)
  }
}

// Both retirements also hold for a load still in flight, so a retired tab's saved draft never returns.
export function retainSavedMobileNativeChatDrafts(
  hostId: string,
  worktreeId: string,
  tabIds: readonly string[]
): void {
  const workspace = workspaceFor(hostId, worktreeId)
  if (workspace.row.state() === 'pending') {
    workspace.retainedTabs = new Set(tabIds)
  }
  workspace.row.save('immediate')
}

export function closeSavedMobileNativeChatDraft(scope: string): void {
  const tab = tabOf(scope)
  if (tab) {
    if (tab.workspace.row.state() === 'pending') {
      tab.workspace.closedTabs.add(tab.tabId)
    }
    tab.workspace.row.save('immediate')
  }
}

export function resetMobileNativeChatDraftPersistenceForTests(): void {
  resetDurableDraftRowsForTests()
  workspaces.clear()
}
