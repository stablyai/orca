import type { WorkspaceSessionState } from '../shared/types'
import {
  collectTerminalScrollbackSnapshotRefs,
  deleteTerminalScrollbackSnapshot,
  type TerminalScrollbackSnapshotStorage,
  writeTerminalScrollbackSnapshot
} from './terminal-scrollback-snapshots'

export async function migrateWorkspaceSessionTerminalScrollbackSnapshotsAsync(
  session: WorkspaceSessionState,
  storage?: TerminalScrollbackSnapshotStorage
): Promise<WorkspaceSessionState> {
  let terminalLayoutsByTabId: WorkspaceSessionState['terminalLayoutsByTabId'] | null = null
  for (const [tabId, layout] of Object.entries(session.terminalLayoutsByTabId ?? {})) {
    const buffers = layout.buffersByLeafId
    if (!buffers || Object.keys(buffers).length === 0) {
      continue
    }
    const refs = { ...layout.scrollbackRefsByLeafId }
    const remainingBuffers: Record<string, string> = {}
    for (const [leafId, buffer] of Object.entries(buffers)) {
      const ref = await writeTerminalScrollbackSnapshot({ tabId, leafId, buffer, storage })
      if (ref) {
        refs[leafId] = ref
      } else {
        remainingBuffers[leafId] = buffer
        delete refs[leafId]
      }
    }
    terminalLayoutsByTabId ??= { ...session.terminalLayoutsByTabId }
    terminalLayoutsByTabId[tabId] = {
      ...layout,
      buffersByLeafId: Object.keys(remainingBuffers).length > 0 ? remainingBuffers : undefined,
      scrollbackRefsByLeafId: Object.keys(refs).length > 0 ? refs : undefined
    }
  }
  return terminalLayoutsByTabId ? { ...session, terminalLayoutsByTabId } : session
}

export async function deleteRemovedTerminalScrollbackSnapshotsAsync(
  prior: WorkspaceSessionState | undefined,
  next: WorkspaceSessionState,
  storage?: TerminalScrollbackSnapshotStorage
): Promise<void> {
  if (!prior) {
    return
  }
  const nextRefs = collectTerminalScrollbackSnapshotRefs(next)
  await Promise.all(
    [...collectTerminalScrollbackSnapshotRefs(prior)]
      .filter((ref) => !nextRefs.has(ref))
      .map((ref) => deleteTerminalScrollbackSnapshot(ref, storage))
  )
}
