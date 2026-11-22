import type { WorkspaceSessionState } from '../../../../shared/workspace-session/workspace-session-state-types'
import { collectLayoutLeafIdsInOrder } from '../../../../shared/workspace-layout/terminal-topology/terminal-pane-tree'
import type { ExecutionHostId } from '../../../../shared/execution-host/execution-host'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/workspace-layout/layout-owner-switch'
import type { StoreRuntimeState } from '../store-runtime-state'

export type GenerationRuntime = Pick<StoreRuntimeState, 'ptyBindingGenerations'> &
  Partial<Pick<StoreRuntimeState, 'ptyBindingGenerationSequence' | 'ptyBindingTrackedTabsByHost'>>

const generationKey = (hostId: ExecutionHostId, leafId: string) => `${hostId}\0${leafId}`

export function bumpPtyBindingGeneration(
  runtime: GenerationRuntime,
  hostId: ExecutionHostId,
  leafId: string
): void {
  if (
    !ORCA_LAYOUT_OWNER_IS_MAIN &&
    !runtime.ptyBindingGenerations.has(generationKey(hostId, leafId))
  ) {
    return
  }
  const key = generationKey(hostId, leafId)
  runtime.ptyBindingGenerationSequence =
    Math.max(
      runtime.ptyBindingGenerationSequence ?? 0,
      runtime.ptyBindingGenerations.get(key) ?? 0
    ) + 1
  runtime.ptyBindingGenerations.set(key, runtime.ptyBindingGenerationSequence)
}

/** Undefined until this process writes the pane binding. */
export function ptyBindingGenerationOf(
  runtime: GenerationRuntime,
  hostId: ExecutionHostId,
  leafId: string
): number | undefined {
  return runtime.ptyBindingGenerations.get(generationKey(hostId, leafId))
}

/** Enroll the pane so snapshot writes reconcile only tabs with restart fences. */
export function trackPtyBindingGeneration(
  runtime: GenerationRuntime,
  { hostId, tabId, leafId }: { hostId: ExecutionHostId; tabId: string; leafId: string }
): number {
  if (runtime.ptyBindingTrackedTabsByHost) {
    const tabs = runtime.ptyBindingTrackedTabsByHost.get(hostId) ?? new Map<string, Set<string>>()
    const leaves = tabs.get(tabId) ?? new Set<string>()
    leaves.add(leafId)
    tabs.set(tabId, leaves)
    runtime.ptyBindingTrackedTabsByHost.set(hostId, tabs)
  }
  const key = generationKey(hostId, leafId)
  const value = runtime.ptyBindingGenerations.get(key)
  if (value !== undefined) {
    return value
  }
  runtime.ptyBindingGenerationSequence = (runtime.ptyBindingGenerationSequence ?? 0) + 1
  runtime.ptyBindingGenerations.set(key, runtime.ptyBindingGenerationSequence)
  return runtime.ptyBindingGenerationSequence
}

function reconcileTrackedPaneBindings(
  runtime: GenerationRuntime,
  hostId: ExecutionHostId,
  before: WorkspaceSessionState | undefined,
  after: WorkspaceSessionState
): void {
  const tracked = runtime.ptyBindingTrackedTabsByHost?.get(hostId)
  if (
    !tracked ||
    (before?.terminalLayoutsByTabId === after.terminalLayoutsByTabId &&
      before?.terminalPtyIncarnationsByPaneKey === after.terminalPtyIncarnationsByPaneKey)
  ) {
    return
  }
  for (const [tabId, leaves] of tracked) {
    const old = before?.terminalLayoutsByTabId?.[tabId]
    const next = after.terminalLayoutsByTabId?.[tabId]
    const present = old === next ? undefined : new Set(collectLayoutLeafIdsInOrder(next?.root))
    for (const leafId of leaves) {
      if (present && !present.has(leafId)) {
        runtime.ptyBindingGenerations.delete(generationKey(hostId, leafId))
        leaves.delete(leafId)
        continue
      }
      const paneKey = `${tabId}:${leafId}`
      if (
        old?.ptyIdsByLeafId?.[leafId] !== next?.ptyIdsByLeafId?.[leafId] ||
        before?.terminalPtyIncarnationsByPaneKey?.[paneKey] !==
          after.terminalPtyIncarnationsByPaneKey?.[paneKey]
      ) {
        bumpPtyBindingGeneration(runtime, hostId, leafId)
      }
    }
    if (leaves.size === 0) {
      tracked.delete(tabId)
    }
  }
  if (tracked.size === 0) {
    runtime.ptyBindingTrackedTabsByHost?.delete(hostId)
  }
}

/** Compare changed layouts only; scalar saves do no work and closed leaves retain no fence entry. */
export function reconcileTrackedPtyBindingGenerations(
  runtime: GenerationRuntime,
  hostId: ExecutionHostId,
  before: WorkspaceSessionState | undefined,
  after: WorkspaceSessionState,
  includeUntrackedRebindings = false
): void {
  if (!includeUntrackedRebindings) {
    reconcileTrackedPaneBindings(runtime, hostId, before, after)
    return
  }
  if (before?.terminalLayoutsByTabId === after.terminalLayoutsByTabId) {
    return
  }
  const was = new Map<string, { tabId: string; ptyId?: string; incarnationId?: string }>()
  const now = new Map<string, { tabId: string; ptyId?: string; incarnationId?: string }>()
  const tabIds = new Set([
    ...Object.keys(before?.terminalLayoutsByTabId ?? {}),
    ...Object.keys(after.terminalLayoutsByTabId ?? {})
  ])
  for (const tabId of tabIds) {
    const old = before?.terminalLayoutsByTabId?.[tabId],
      next = after.terminalLayoutsByTabId?.[tabId]
    if (old === next) {
      continue
    }
    for (const [layout, session, target] of [
      [old, before, was],
      [next, after, now]
    ] as const) {
      for (const leafId of collectLayoutLeafIdsInOrder(layout?.root)) {
        target.set(leafId, {
          tabId,
          ptyId: layout?.ptyIdsByLeafId?.[leafId],
          incarnationId: session?.terminalPtyIncarnationsByPaneKey?.[`${tabId}:${leafId}`]
        })
      }
    }
  }
  for (const [leafId, next] of now) {
    const old = was.get(leafId)
    const tracked = runtime.ptyBindingGenerations.has(generationKey(hostId, leafId))
    if (
      old?.ptyId !== next.ptyId ||
      (tracked && old && (old.tabId !== next.tabId || old.incarnationId !== next.incarnationId))
    ) {
      bumpPtyBindingGeneration(runtime, hostId, leafId)
    }
  }
  const trackedTabs = runtime.ptyBindingTrackedTabsByHost?.get(hostId)
  for (const [leafId, old] of was) {
    const next = now.get(leafId)
    if (!next) {
      runtime.ptyBindingGenerations.delete(generationKey(hostId, leafId))
    }
    if (next?.tabId !== old.tabId) {
      const leaves = trackedTabs?.get(old.tabId)
      leaves?.delete(leafId)
      if (leaves?.size === 0) {
        trackedTabs?.delete(old.tabId)
      }
    }
  }
  if (trackedTabs?.size === 0) {
    runtime.ptyBindingTrackedTabsByHost?.delete(hostId)
  }
}

export function hasPtyBindingGenerations(
  runtime: Partial<GenerationRuntime>
): runtime is GenerationRuntime {
  return runtime.ptyBindingGenerations !== undefined
}
