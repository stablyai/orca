import type { BrowserWindow } from 'electron'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import {
  LOCAL_EXECUTION_HOST_ID,
  normalizeExecutionHostId,
  type ExecutionHostId
} from '../../shared/execution-host'
import type {
  WorkspaceSessionPatch,
  WorkspaceSessionState
} from '../../shared/workspace-session-state-types'
import type { TabGroup } from '../../shared/tab-types'
import type { Store } from '../persistence'
import { orcaWindowManager, type OrcaWindowManager } from '../window/orca-window-manager'

export type HostSessionSnapshot = {
  state: WorkspaceSessionState
  hostId?: ExecutionHostId
}

const RECORD_MAP_FIELDS = [
  'openFilesByWorktree',
  'activeFileIdByWorktree',
  'markdownFrontmatterVisible',
  'browserTabsByWorktree',
  'browserPagesByWorkspace',
  'activeBrowserTabIdByWorktree',
  'activeTabTypeByWorktree',
  'activeTabIdByWorktree',
  'tabGroupLayouts',
  'activeGroupIdByWorktree',
  'remoteSessionIdsByTabId',
  'lastVisitedAtByWorktreeId',
  'defaultTerminalTabsAppliedByWorktreeId',
  'sleepingAgentSessionsByPaneKey',
  'terminalPtyIncarnationsByPaneKey',
  'terminalSurfaceTombstonesByPaneKey'
] as const

type RecordEntry = {
  state: WorkspaceSessionState
  retired: boolean
}

function resolveHostId(hostId?: string | null): ExecutionHostId {
  return normalizeExecutionHostId(hostId) ?? LOCAL_EXECUTION_HOST_ID
}

function cloneSession(state: WorkspaceSessionState): WorkspaceSessionState {
  return structuredClone(state)
}

function mergeItemsById<T extends { id: string }>(lists: readonly (readonly T[])[]): T[] {
  const seen = new Set<string>()
  const merged: T[] = []
  for (const list of lists) {
    for (const item of list) {
      if (!seen.has(item.id)) {
        seen.add(item.id)
        merged.push(item)
      }
    }
  }
  return merged
}

function mergeArrayMapById<T extends { id: string }>(
  states: readonly WorkspaceSessionState[],
  read: (state: WorkspaceSessionState) => Record<string, T[]> | undefined
): Record<string, T[]> {
  const keys = new Set(states.flatMap((state) => Object.keys(read(state) ?? {})))
  return Object.fromEntries(
    [...keys].map((key) => [key, mergeItemsById(states.map((state) => read(state)?.[key] ?? []))])
  )
}

function mergeRecordField(
  states: readonly WorkspaceSessionState[],
  field: (typeof RECORD_MAP_FIELDS)[number]
): Record<string, unknown> | undefined {
  let merged: Record<string, unknown> | undefined
  for (const state of states.toReversed()) {
    const value = state[field]
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      merged = { ...merged, ...(value as Record<string, unknown>) }
    }
  }
  return merged
}

function mergeStringArrays(
  values: readonly (readonly string[] | undefined)[]
): string[] | undefined {
  const merged = [...new Set(values.flatMap((value) => value ?? []))]
  return merged.length > 0 ? merged : undefined
}

function mergeTabGroups(states: readonly WorkspaceSessionState[]): Record<string, TabGroup[]> {
  const keys = new Set(states.flatMap((state) => Object.keys(state.tabGroups ?? {})))
  return Object.fromEntries(
    [...keys].map((key) => {
      const groups = new Map<string, TabGroup>()
      for (const state of states) {
        for (const group of state.tabGroups?.[key] ?? []) {
          const existing = groups.get(group.id)
          groups.set(
            group.id,
            existing
              ? {
                  ...existing,
                  activeTabId: existing.activeTabId ?? group.activeTabId,
                  tabOrder: [...new Set([...existing.tabOrder, ...group.tabOrder])],
                  recentTabIds: mergeStringArrays([existing.recentTabIds, group.recentTabIds])
                }
              : group
          )
        }
      }
      return [key, [...groups.values()]]
    })
  )
}

export function mergeWindowSessions(
  states: readonly WorkspaceSessionState[]
): WorkspaceSessionState {
  if (states.length === 0) {
    return getDefaultWorkspaceSession()
  }
  const merged = cloneSession(states[0])
  merged.tabsByWorktree = mergeArrayMapById(states, (state) => state.tabsByWorktree)
  merged.terminalLayoutsByTabId = {}
  for (const state of states) {
    for (const [tabId, layout] of Object.entries(state.terminalLayoutsByTabId)) {
      merged.terminalLayoutsByTabId[tabId] ??= layout
    }
  }

  const unifiedTabs = mergeArrayMapById(states, (state) => state.unifiedTabs)
  if (Object.keys(unifiedTabs).length > 0) {
    merged.unifiedTabs = unifiedTabs
  }
  const tabGroups = mergeTabGroups(states)
  if (Object.keys(tabGroups).length > 0) {
    merged.tabGroups = tabGroups
  }

  const asMutable = merged as unknown as Record<string, unknown>
  for (const field of RECORD_MAP_FIELDS) {
    const value = mergeRecordField(states, field)
    if (value) {
      asMutable[field] = value
    }
  }

  const topology: Record<string, number> = {}
  for (const state of states) {
    for (const [repoId, revision] of Object.entries(state.terminalTopologyRevisionByRepoId ?? {})) {
      topology[repoId] = Math.max(topology[repoId] ?? 0, revision)
    }
  }
  if (Object.keys(topology).length > 0) {
    merged.terminalTopologyRevisionByRepoId = topology
  }

  merged.activeWorktreeIdsOnShutdown = mergeStringArrays(
    states.map((state) => state.activeWorktreeIdsOnShutdown)
  )
  merged.activeConnectionIdsAtShutdown = mergeStringArrays(
    states.map((state) => state.activeConnectionIdsAtShutdown)
  )
  return merged
}

export class WindowSessionRegistry {
  readonly #records = new Map<number, Map<ExecutionHostId, RecordEntry>>()
  readonly #store: Store
  readonly #windows: Pick<OrcaWindowManager, 'getControlWindow'>
  #quitFrozen = false

  constructor(
    store: Store,
    windows: Pick<OrcaWindowManager, 'getControlWindow'> = orcaWindowManager
  ) {
    this.#store = store
    this.#windows = windows
  }

  seedWindow(windowId: number, sessions: ReadonlyMap<string, WorkspaceSessionState>): void {
    for (const [hostId, state] of sessions) {
      this.#setRecord(windowId, state, resolveHostId(hostId))
    }
  }

  get(windowId: number, hostId?: string | null): WorkspaceSessionState {
    const resolved = resolveHostId(hostId)
    const existing = this.#records.get(windowId)?.get(resolved)
    if (existing && !existing.retired) {
      return cloneSession(existing.state)
    }
    const initial = cloneSession(this.#store.getWorkspaceSession(resolved))
    this.#setRecord(windowId, initial, resolved)
    return cloneSession(initial)
  }

  set(windowId: number, state: WorkspaceSessionState, hostId?: string | null): void {
    const resolved = resolveHostId(hostId)
    this.#setRecord(windowId, state, resolved)
    this.#persistHost(resolved)
  }

  patch(windowId: number, patch: WorkspaceSessionPatch, hostId?: string | null): void {
    const resolved = resolveHostId(hostId)
    const current = this.get(windowId, resolved)
    this.#setRecord(
      windowId,
      { ...current, ...cloneSession(patch as WorkspaceSessionState) },
      resolved
    )
    this.#persistHost(resolved)
  }

  retire(windowId: number, _mode: 'user-close' | 'empty-close'): void {
    if (this.#quitFrozen) {
      return
    }
    const records = this.#records.get(windowId)
    if (!records) {
      return
    }
    for (const [hostId, record] of records) {
      record.retired = true
      this.#persistHost(hostId)
    }
  }

  freezeForQuit(): void {
    this.#quitFrozen = true
  }

  resumeAfterQuitAbort(): void {
    this.#quitFrozen = false
  }

  stageBeforeUnload(windowId: number, sessions: readonly HostSessionSnapshot[]): void {
    const touchedHosts = new Set<ExecutionHostId>()
    for (const { state, hostId } of sessions) {
      const resolved = resolveHostId(hostId)
      this.#setRecord(windowId, state, resolved)
      touchedHosts.add(resolved)
    }
    for (const hostId of touchedHosts) {
      this.#store.stageWorkspaceSessionBeforeUnload(this.mergeHost(hostId), hostId)
    }
  }

  mergeHost(hostId?: string | null): WorkspaceSessionState {
    const resolved = resolveHostId(hostId)
    const controlId = (this.#windows.getControlWindow() as BrowserWindow | null)?.id ?? null
    const records = [...this.#records]
      .flatMap(([windowId, byHost]) => {
        const record = byHost.get(resolved)
        return record && !record.retired ? [{ windowId, state: record.state }] : []
      })
      .sort((a, b) => {
        if (a.windowId === controlId) {
          return -1
        }
        if (b.windowId === controlId) {
          return 1
        }
        return a.windowId - b.windowId
      })
    return records.length > 0
      ? mergeWindowSessions(records.map(({ state }) => state))
      : cloneSession(this.#store.getWorkspaceSession(resolved))
  }

  #setRecord(windowId: number, state: WorkspaceSessionState, hostId: ExecutionHostId): void {
    const byHost = this.#records.get(windowId) ?? new Map<ExecutionHostId, RecordEntry>()
    byHost.set(hostId, { state: cloneSession(state), retired: false })
    this.#records.set(windowId, byHost)
  }

  #persistHost(hostId: ExecutionHostId): void {
    this.#store.setWorkspaceSession(this.mergeHost(hostId), hostId)
  }
}

const registries = new WeakMap<Store, WindowSessionRegistry>()

export function getWindowSessionRegistry(store: Store): WindowSessionRegistry {
  let registry = registries.get(store)
  if (!registry) {
    registry = new WindowSessionRegistry(store)
    registries.set(store, registry)
  }
  return registry
}
