import { mkdtempSync, rmSync, statSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { getDefaultWorkspaceSession } from '../../../shared/constants'
import type { WorkspaceSessionState } from '../../../shared/workspace-session/workspace-session-state-types'
import {
  getTerminalScrollbackSnapshotPath,
  writeTerminalScrollbackSnapshotSync
} from '../../pty/scrollback/terminal-scrollback-snapshots'
import { deleteRemovedTerminalScrollbackSnapshots } from '../loading-store/workspace-sessions/terminal-session-cleanup'
import { deleteRemovedTerminalScrollbackSnapshotsAsync } from '../../pty/scrollback/terminal-scrollback-snapshot-async-migration'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function storage() {
  const root = mkdtempSync(join(tmpdir(), 'orcad-export-holds-'))
  roots.push(root)
  return { root, storage: { snapshotRoot: join(root, 'terminal-scrollback') } }
}

function sessionWithRef(ref: string | null): WorkspaceSessionState {
  return {
    ...getDefaultWorkspaceSession(),
    terminalLayoutsByTabId: ref
      ? {
          'tab-1': {
            root: null,
            activeLeafId: null,
            expandedLeafId: null,
            scrollbackRefsByLeafId: { 'leaf-1': ref }
          }
        }
      : {}
  }
}

describe('scrollback store reads and retention for migration export', () => {
  it.each(['sync', 'async'] as const)(
    'keeps a %s-removed snapshot a pending export still reads',
    async (mode) => {
      const { storage: store } = storage()
      const ref =
        writeTerminalScrollbackSnapshotSync({
          tabId: 'tab-1',
          leafId: 'leaf-1',
          buffer: 'retained',
          storage: store
        }) ?? ''
      const path = getTerminalScrollbackSnapshotPath(ref, store) ?? ''
      const retained = new Set([ref])
      if (mode === 'sync') {
        deleteRemovedTerminalScrollbackSnapshots(
          sessionWithRef(ref),
          sessionWithRef(null),
          store,
          retained
        )
      } else {
        await deleteRemovedTerminalScrollbackSnapshotsAsync(
          sessionWithRef(ref),
          sessionWithRef(null),
          store,
          retained
        )
      }
      expect(readFileSync(path, 'utf8')).toBe('retained')
      deleteRemovedTerminalScrollbackSnapshots(sessionWithRef(ref), sessionWithRef(null), store)
      expect(() => statSync(path)).toThrow()
    }
  )
})
