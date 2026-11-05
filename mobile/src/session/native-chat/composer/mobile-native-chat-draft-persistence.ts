import AsyncStorage from '@react-native-async-storage/async-storage'
import type { AgentJournalSkillRef } from '../../../../../src/shared/agent-session/journal/agent-session-journal-types'
import {
  PAGE_STORAGE_MAX_VALUE_CHARS,
  workspaceScopedKey
} from '../../../mobile-web-shell/page-storage-keys'
import { persistMirroredReadBack } from '../../../storage/mirrored-storage-keys'

// Why this slot: every shell since 0.0.59 lets session pages keep it, and #37900 retired the terminal drafts it held.
const STORAGE_PREFIX = 'orca:terminalDrafts:'
const PERSIST_DEBOUNCE_MS = 250

export type MobileNativeChatSavedDraft = {
  text: string
  skills: readonly AgentJournalSkillRef[]
  skillOrigin?: string
}

export type MobileNativeChatDraftSource = {
  // Every scope's saveable draft; only tab scopes are kept.
  saved: () => Map<string, MobileNativeChatSavedDraft>
  // Puts back a saved draft unless the tab already holds user text.
  restore: (scope: string, draft: MobileNativeChatSavedDraft) => void
}

type Workspace = {
  key: string
  hostId: string
  worktreeId: string
  // Every read and write of the key runs in order, the load first.
  chain: Promise<void>
  // A shell that refuses this page the key refuses it for the whole page, so the load is not retried.
  load: 'pending' | 'loaded' | 'unreadable'
  // What storage holds; undefined after a write that failed partway, so the next save cannot match it.
  written: string | null | undefined
  timer: ReturnType<typeof setTimeout> | null
  // Retirements seen before the load lands; the load must not bring those tabs back.
  retainedTabs: ReadonlySet<string> | null
  closedTabs: Set<string>
}

const workspaces = new Map<string, Workspace>()
// Set by the draft store when it loads, before anything can save or load.
let source!: MobileNativeChatDraftSource

export function setMobileNativeChatDraftSource(next: MobileNativeChatDraftSource): void {
  source = next
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseSkills(value: unknown): AgentJournalSkillRef[] {
  return Array.isArray(value)
    ? value.flatMap((skill) =>
        isRecord(skill) && typeof skill.name === 'string' && typeof skill.path === 'string'
          ? [{ name: skill.name, path: skill.path }]
          : []
      )
    : []
}

// Anything else, including an older build's terminal drafts, reads as no drafts.
function parseSavedDrafts(raw: string | null): Map<string, MobileNativeChatSavedDraft> {
  const saved = new Map<string, MobileNativeChatSavedDraft>()
  let value: unknown
  try {
    value = JSON.parse(raw ?? 'null')
  } catch {
    return saved
  }
  if (!isRecord(value) || !isRecord(value.chatDrafts)) {
    return saved
  }
  for (const [tabId, draft] of Object.entries(value.chatDrafts)) {
    if (isRecord(draft) && typeof draft.text === 'string' && draft.text !== '') {
      saved.set(tabId, {
        text: draft.text,
        skills: parseSkills(draft.skills),
        skillOrigin: typeof draft.skillOrigin === 'string' ? draft.skillOrigin : undefined
      })
    }
  }
  return saved
}

// Drafts that would push the value past the shell's cap stay in memory, so a refused write never leaves sent text stored.
function serializeSavedDrafts(drafts: Map<string, MobileNativeChatSavedDraft>): string | null {
  if (drafts.size === 0) {
    return null
  }
  const whole = JSON.stringify({ chatDrafts: Object.fromEntries(drafts) })
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

function workspaceFor(hostId: string, worktreeId: string): Workspace {
  const key = workspaceScopedKey(STORAGE_PREFIX, hostId, worktreeId)
  let workspace = workspaces.get(key)
  if (!workspace) {
    workspace = {
      key,
      hostId,
      worktreeId,
      chain: Promise.resolve(),
      load: 'pending',
      written: null,
      timer: null,
      retainedTabs: null,
      closedTabs: new Set()
    }
    workspaces.set(key, workspace)
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

function enqueue(workspace: Workspace, step: () => Promise<void>): Promise<void> {
  workspace.chain = workspace.chain.then(step).catch((error: unknown) => {
    console.warn('[native-chat-drafts] a draft could not be saved; it is kept in memory', error)
  })
  return workspace.chain
}

async function load(workspace: Workspace): Promise<void> {
  if (workspace.load !== 'pending') {
    return
  }
  let raw: string | null
  try {
    raw = await AsyncStorage.getItem(workspace.key)
  } catch {
    workspace.load = 'unreadable'
    return
  }
  workspace.load = 'loaded'
  workspace.written = raw
  for (const [tabId, draft] of parseSavedDrafts(raw)) {
    const live = workspace.retainedTabs?.has(tabId) ?? true
    if (live && !workspace.closedTabs.has(tabId)) {
      source.restore(`${workspace.hostId}\0${workspace.worktreeId}\0${tabId}`, draft)
    }
  }
  workspace.retainedTabs = null
  workspace.closedTabs.clear()
}

async function write(workspace: Workspace): Promise<void> {
  await load(workspace)
  if (workspace.load !== 'loaded') {
    return
  }
  const drafts = new Map<string, MobileNativeChatSavedDraft>()
  for (const [scope, draft] of source.saved()) {
    const tab = tabOf(scope)
    if (tab?.workspace === workspace) {
      drafts.set(tab.tabId, draft)
    }
  }
  const value = serializeSavedDrafts(drafts)
  if (value === workspace.written) {
    return
  }
  workspace.written = undefined
  // Page stores can resolve a dropped write; recording what stuck makes the next save retry it.
  workspace.written = await persistMirroredReadBack(workspace.key, value)
}

function flush(workspace: Workspace): void {
  if (workspace.timer !== null) {
    clearTimeout(workspace.timer)
    workspace.timer = null
  }
  void enqueue(workspace, () => write(workspace))
}

// The app going to the background may be the last chance before it is killed, so pending typing saves then.
function flushPendingOnHide(): void {
  if (document.visibilityState !== 'hidden') {
    return
  }
  for (const workspace of workspaces.values()) {
    if (workspace.timer !== null) {
      flush(workspace)
    }
  }
}

let flushOnHideInstalled = false

/** Restores a workspace's saved chat drafts once per page; later calls wait for that load. */
export function loadMobileNativeChatDrafts(hostId: string, worktreeId: string): Promise<void> {
  if (!flushOnHideInstalled && typeof document !== 'undefined') {
    flushOnHideInstalled = true
    document.addEventListener('visibilitychange', flushPendingOnHide)
  }
  const workspace = workspaceFor(hostId, worktreeId)
  return enqueue(workspace, () => load(workspace))
}

/** Typing coalesces; clears save at once so a sent draft cannot come back. */
export function saveMobileNativeChatDraft(scope: string, timing: 'immediate' | 'deferred'): void {
  const workspace = tabOf(scope)?.workspace
  if (!workspace) {
    return
  }
  if (timing === 'immediate') {
    flush(workspace)
    return
  }
  workspace.timer ??= setTimeout(() => flush(workspace), PERSIST_DEBOUNCE_MS)
}

// Both retirements also hold for a load still in flight, so a retired tab's saved draft never returns.
export function retainSavedMobileNativeChatDrafts(
  hostId: string,
  worktreeId: string,
  tabIds: readonly string[]
): void {
  const workspace = workspaceFor(hostId, worktreeId)
  if (workspace.load === 'pending') {
    workspace.retainedTabs = new Set(tabIds)
  }
  flush(workspace)
}

export function closeSavedMobileNativeChatDraft(scope: string): void {
  const tab = tabOf(scope)
  if (tab) {
    if (tab.workspace.load === 'pending') {
      tab.workspace.closedTabs.add(tab.tabId)
    }
    flush(tab.workspace)
  }
}

export function resetMobileNativeChatDraftPersistenceForTests(): void {
  for (const workspace of workspaces.values()) {
    if (workspace.timer !== null) {
      clearTimeout(workspace.timer)
    }
  }
  workspaces.clear()
}
