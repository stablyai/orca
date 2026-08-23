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
import type { Store } from '../persistence'
import { orcaWindowManager, type OrcaWindowManager } from '../window/orca-window-manager'
import { mergeWindowSessions } from './window-session-merge'

export type HostSessionSnapshot = {
  state: WorkspaceSessionState
  hostId?: ExecutionHostId
}

type RecordEntry = {
  state: WorkspaceSessionState
  retired: boolean
  rendererUnavailable: boolean
}

type SessionWindowManager = Pick<OrcaWindowManager, 'getControlWindow'> &
  Partial<Pick<OrcaWindowManager, 'getMostRecentWindow'>>

function resolveHostId(hostId?: string | null): ExecutionHostId {
  return normalizeExecutionHostId(hostId) ?? LOCAL_EXECUTION_HOST_ID
}

function cloneSession(state: WorkspaceSessionState): WorkspaceSessionState {
  return structuredClone(state)
}

function sessionHasWindowContent(state: WorkspaceSessionState): boolean {
  return [
    state.unifiedTabs,
    state.tabsByWorktree,
    state.openFilesByWorktree,
    state.browserTabsByWorktree
  ].some((byWorkspace) => Object.values(byWorkspace ?? {}).some((items) => items.length > 0))
}

export class WindowSessionRegistry {
  readonly #records = new Map<number, Map<ExecutionHostId, RecordEntry>>()
  readonly #store: Store
  readonly #windows: SessionWindowManager
  #quitFrozen = false

  constructor(store: Store, windows: SessionWindowManager = orcaWindowManager) {
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
      if (record.rendererUnavailable) {
        continue
      }
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

  markRendererUnavailable(windowId: number): void {
    for (const record of this.#records.get(windowId)?.values() ?? []) {
      record.rendererUnavailable = true
    }
  }

  isWindowEmptyAcrossHosts(windowId: number): boolean {
    const records = [...(this.#records.get(windowId)?.values() ?? [])].filter(
      (record) => !record.retired
    )
    return (
      records.length > 0 &&
      records.every(
        (record) => !record.rendererUnavailable && !sessionHasWindowContent(record.state)
      )
    )
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

  stageAllKnownHostsBeforeQuit(): void {
    const hostIds = new Set<ExecutionHostId>(this.#store.getWorkspaceSessionHostIds())
    for (const byHost of this.#records.values()) {
      for (const hostId of byHost.keys()) {
        hostIds.add(hostId)
      }
    }
    for (const hostId of hostIds) {
      this.#store.stageWorkspaceSessionBeforeUnload(this.mergeHost(hostId), hostId)
    }
  }

  mergeHost(hostId?: string | null): WorkspaceSessionState {
    const resolved = resolveHostId(hostId)
    const hasKnownRecord = [...this.#records.values()].some((byHost) => byHost.has(resolved))
    const controlId =
      (this.#windows.getControlWindow() ?? this.#windows.getMostRecentWindow?.())?.id ?? null
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
      : hasKnownRecord
        ? getDefaultWorkspaceSession()
        : cloneSession(this.#store.getWorkspaceSession(resolved))
  }

  #setRecord(windowId: number, state: WorkspaceSessionState, hostId: ExecutionHostId): void {
    const byHost = this.#records.get(windowId) ?? new Map<ExecutionHostId, RecordEntry>()
    byHost.set(hostId, { state: cloneSession(state), retired: false, rendererUnavailable: false })
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
