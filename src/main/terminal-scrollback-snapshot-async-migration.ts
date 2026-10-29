import type { TerminalLayoutSnapshot } from '../shared/terminal-tab-types'
import type { WorkspaceSessionState } from '../shared/workspace-session-state-types'
import {
  collectTerminalScrollbackSnapshotRefs,
  deleteTerminalScrollbackSnapshot,
  type TerminalScrollbackSnapshotStorage,
  prepareTerminalScrollbackSnapshot,
  type PreparedTerminalScrollbackSnapshot
} from './terminal-scrollback-snapshots'

export async function migrateWorkspaceSessionTerminalScrollbackSnapshotsAsync(
  session: WorkspaceSessionState,
  storage?: TerminalScrollbackSnapshotStorage,
  admit?: (tabId: string, commit: () => TerminalLayoutSnapshot) => void
): Promise<WorkspaceSessionState> {
  let terminalLayoutsByTabId: WorkspaceSessionState['terminalLayoutsByTabId'] | null = null
  for (const [tabId, layout] of Object.entries(session.terminalLayoutsByTabId ?? {})) {
    const buffers = layout.buffersByLeafId
    if (!buffers || Object.keys(buffers).length === 0) {
      continue
    }
    const prepared = new Map<string, PreparedTerminalScrollbackSnapshot | null>()
    try {
      for (const [leafId, buffer] of Object.entries(buffers)) {
        prepared.set(
          leafId,
          await prepareTerminalScrollbackSnapshot({ tabId, leafId, buffer, storage })
        )
      }
      const commit = (): TerminalLayoutSnapshot => {
        const refs = { ...layout.scrollbackRefsByLeafId }
        const remainingBuffers: Record<string, string> = {}
        for (const [leafId, buffer] of Object.entries(buffers)) {
          const ref = prepared.get(leafId)?.commit()
          if (ref) {
            refs[leafId] = ref
          } else {
            remainingBuffers[leafId] = buffer
            delete refs[leafId]
          }
        }
        return {
          ...layout,
          buffersByLeafId: Object.keys(remainingBuffers).length ? remainingBuffers : undefined,
          scrollbackRefsByLeafId: Object.keys(refs).length ? refs : undefined
        }
      }
      if (admit) {
        admit(tabId, commit)
      } else {
        terminalLayoutsByTabId ??= { ...session.terminalLayoutsByTabId }
        terminalLayoutsByTabId[tabId] = commit()
      }
    } finally {
      await Promise.all([...prepared.values()].map(async (entry) => entry?.discard()))
    }
  }
  return terminalLayoutsByTabId ? { ...session, terminalLayoutsByTabId } : session
}

export async function deleteRemovedTerminalScrollbackSnapshotsAsync(
  prior: WorkspaceSessionState | undefined,
  next: WorkspaceSessionState,
  storage?: TerminalScrollbackSnapshotStorage,
  retainedRefs: ReadonlySet<string> = new Set()
): Promise<void> {
  if (!prior) {
    return
  }
  const nextRefs = collectTerminalScrollbackSnapshotRefs(next)
  await Promise.all(
    [...collectTerminalScrollbackSnapshotRefs(prior)]
      .filter((ref) => !nextRefs.has(ref) && !retainedRefs.has(ref))
      .map((ref) => deleteTerminalScrollbackSnapshot(ref, storage))
  )
}
