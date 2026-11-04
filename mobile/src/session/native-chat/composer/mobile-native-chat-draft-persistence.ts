import AsyncStorage from '@react-native-async-storage/async-storage'
import type { AgentJournalSkillRef } from '../../../../../src/shared/agent-session/journal/agent-session-journal-types'
import { PAGE_STORAGE_MAX_VALUE_CHARS } from '../../../mobile-web-shell/page-storage-keys'
import { persistMirrored } from '../../../storage/mirrored-storage-keys'

// Why this slot: every shell since 0.0.59 lets session pages keep it, and #37900 retired the terminal drafts it held.
const STORAGE_PREFIX = 'orca:terminalDrafts:'
const PERSIST_DEBOUNCE_MS = 250

export type MobileNativeChatSavedDraft = {
  text: string
  skills: readonly AgentJournalSkillRef[]
  skillOrigin?: string
}

export type MobileNativeChatDraftSource = {
  // The workspace's saveable tab drafts, by tab id.
  saved: (scopePrefix: string) => Map<string, MobileNativeChatSavedDraft>
  // Puts back a saved draft unless the tab already holds user text.
  restore: (scope: string, draft: MobileNativeChatSavedDraft) => void
}

type Workspace = {
  key: string
  scopePrefix: string
  // Every read and write of the key runs in order, the load first.
  chain: Promise<void>
  loaded: boolean
  // A shell that refuses this page the key refuses it for the whole page, so the load is not retried.
  unreadable: boolean
  // What storage holds; undefined after a write that failed partway, so the next save cannot match it.
  written: string | null | undefined
  timer: ReturnType<typeof setTimeout> | null
  retainedTabs: ReadonlySet<string> | null
  closedTabs: Set<string>
}

const workspaces = new Map<string, Workspace>()
let source: MobileNativeChatDraftSource | null = null

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
        ...(typeof draft.skillOrigin === 'string' ? { skillOrigin: draft.skillOrigin } : {})
      })
    }
  }
  return saved
}

// Drafts that would push the value past the shell's cap stay in memory, so a refused write never leaves sent text stored.
function serializeSavedDrafts(drafts: Map<string, MobileNativeChatSavedDraft>): string | null {
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
  const scopePrefix = `${hostId}\0${worktreeId}\0`
  let workspace = workspaces.get(scopePrefix)
  if (!workspace) {
    workspace = {
      key: `${STORAGE_PREFIX}${encodeURIComponent(hostId)}:${encodeURIComponent(worktreeId)}`,
      scopePrefix,
      chain: Promise.resolve(),
      loaded: false,
      unreadable: false,
      written: null,
      timer: null,
      retainedTabs: null,
      closedTabs: new Set()
    }
    workspaces.set(scopePrefix, workspace)
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
  if (workspace.loaded || workspace.unreadable || !source) {
    return
  }
  let raw: string | null
  try {
    raw = await AsyncStorage.getItem(workspace.key)
  } catch {
    workspace.unreadable = true
    return
  }
  workspace.loaded = true
  workspace.written = raw
  for (const [tabId, draft] of parseSavedDrafts(raw)) {
    const live = workspace.retainedTabs?.has(tabId) ?? true
    if (live && !workspace.closedTabs.has(tabId)) {
      source.restore(`${workspace.scopePrefix}${tabId}`, draft)
    }
  }
}

async function write(workspace: Workspace): Promise<void> {
  await load(workspace)
  if (!workspace.loaded || !source) {
    return
  }
  const value = serializeSavedDrafts(source.saved(workspace.scopePrefix))
  if (value === workspace.written) {
    return
  }
  workspace.written = undefined
  await persistMirrored(workspace.key, value)
  // Page stores can resolve a dropped write; recording what stuck makes the next save retry it.
  workspace.written = await AsyncStorage.getItem(workspace.key)
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
  workspace.retainedTabs = new Set(tabIds)
  flush(workspace)
}

export function closeSavedMobileNativeChatDraft(scope: string): void {
  const tab = tabOf(scope)
  if (tab) {
    tab.workspace.closedTabs.add(tab.tabId)
    flush(tab.workspace)
  }
}

export async function mobileNativeChatDraftWritesSettledForTests(): Promise<void> {
  await Promise.all([...workspaces.values()].map((workspace) => workspace.chain))
}

export function resetMobileNativeChatDraftPersistenceForTests(): void {
  for (const workspace of workspaces.values()) {
    if (workspace.timer !== null) {
      clearTimeout(workspace.timer)
    }
  }
  workspaces.clear()
}
