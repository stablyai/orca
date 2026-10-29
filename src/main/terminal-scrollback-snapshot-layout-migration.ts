import type { WorkspaceSessionState } from '../shared/workspace-session-state-types'

import {
  type TerminalScrollbackSnapshotStorage,
  writeTerminalScrollbackSnapshotSync
} from './terminal-scrollback-snapshots'
export function migrateWorkspaceSessionTerminalScrollbackSnapshots(
  session: WorkspaceSessionState,
  storage?: TerminalScrollbackSnapshotStorage
): { session: WorkspaceSessionState; changed: boolean } {
  let terminalLayoutsByTabId: WorkspaceSessionState['terminalLayoutsByTabId'] | null = null
  for (const [tabId, layout] of Object.entries(session.terminalLayoutsByTabId ?? {})) {
    const migrated = migrateTerminalLayoutScrollbackSnapshots(tabId, layout, storage)
    if (migrated !== layout) {
      terminalLayoutsByTabId ??= { ...session.terminalLayoutsByTabId }
      terminalLayoutsByTabId[tabId] = migrated
    }
  }
  if (!terminalLayoutsByTabId) {
    return { session, changed: false }
  }
  return { session: { ...session, terminalLayoutsByTabId }, changed: true }
}

export function migrateTerminalLayoutScrollbackSnapshots(
  tabId: string,
  layout: WorkspaceSessionState['terminalLayoutsByTabId'][string],
  storage?: TerminalScrollbackSnapshotStorage
): WorkspaceSessionState['terminalLayoutsByTabId'][string] {
  const buffers = layout.buffersByLeafId
  if (!buffers || Object.keys(buffers).length === 0) {
    return layout
  }
  const refs = { ...layout.scrollbackRefsByLeafId }
  const remainingBuffers: Record<string, string> = {}
  let layoutChanged = false
  for (const [leafId, buffer] of Object.entries(buffers)) {
    const ref = writeTerminalScrollbackSnapshotSync({ tabId, leafId, buffer, storage })
    if (ref) {
      refs[leafId] = ref
      layoutChanged = true
    } else {
      remainingBuffers[leafId] = buffer
      if (refs[leafId]) {
        delete refs[leafId]
        layoutChanged = true
      }
    }
  }
  if (!layoutChanged) {
    return layout
  }
  const nextLayout = { ...layout }
  if (Object.keys(refs).length > 0) {
    nextLayout.scrollbackRefsByLeafId = refs
  } else {
    delete nextLayout.scrollbackRefsByLeafId
  }
  if (Object.keys(remainingBuffers).length > 0) {
    nextLayout.buffersByLeafId = remainingBuffers
  } else {
    delete nextLayout.buffersByLeafId
  }
  return nextLayout
}
