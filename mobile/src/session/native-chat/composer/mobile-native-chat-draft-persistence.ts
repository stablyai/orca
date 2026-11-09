import AsyncStorage from '@react-native-async-storage/async-storage'
import {
  PAGE_STORAGE_MAX_VALUE_CHARS,
  workspaceScopedKey
} from '../../../mobile-web-shell/page-storage-keys'
import { readPageDeviceStore } from '../../../mobile-web-shell/bridge/page-device-store'
import {
  DEVICE_STORE_MAX_VALUE_LENGTH,
  encodeDeviceStoreValue
} from '../../../device-store/device-store-value-codec'
import { persistMirroredReadBack } from '../../../storage/mirrored-storage-keys'
import {
  fitSavedDrafts,
  parseSavedDrafts,
  savedDraftsValue,
  type MobileNativeChatSavedDraft
} from './mobile-native-chat-saved-drafts'
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

const encodeLegacySlot = (value: unknown): string | null =>
  value === null ? null : JSON.stringify(value)

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
      const fitted = fitSavedDrafts(
        value,
        encodeLegacySlot,
        (encoded) => (encoded?.length ?? 0) <= PAGE_STORAGE_MAX_VALUE_CHARS
      )
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
    write: (value) =>
      row.write(
        fitSavedDrafts(
          value,
          (fitted) => fitted,
          (fitted) => encodeDeviceStoreValue(fitted).length <= DEVICE_STORE_MAX_VALUE_LENGTH
        )
      )
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
