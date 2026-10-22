import { mkdtempSync, rmSync, statSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../shared/constants'
import type { WorkspaceSessionState } from '../shared/workspace-session-state-types'
import { writeFileDurableSync } from './durable-file-write'
import {
  getTerminalScrollbackSnapshotPath,
  readTerminalScrollbackStoredBytesSync,
  writeTerminalScrollbackSnapshotSync
} from './terminal-scrollback-snapshots'
import { deleteRemovedTerminalScrollbackSnapshots } from './persistence/loading-store/terminal-session-cleanup'
import { deleteRemovedTerminalScrollbackSnapshotsAsync } from './terminal-scrollback-snapshot-async-migration'
import { extractSessionOwnersForTransfer } from './orca-profiles/profile-session-owner-transfer'
import type { SleepingAgentSessionRecord } from '../shared/agent-session-resume'

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
  it('reads stored bytes for a ref and none for an unknown one', () => {
    const { storage: store } = storage()
    const ref = writeTerminalScrollbackSnapshotSync({
      tabId: 'tab-1',
      leafId: 'leaf-1',
      buffer: 'saved output',
      storage: store
    })
    expect(ref).not.toBeNull()
    expect(readTerminalScrollbackStoredBytesSync(ref ?? '', store)?.toString('utf8')).toBe(
      'saved output'
    )
    expect(readTerminalScrollbackStoredBytesSync(`v1-${'0'.repeat(32)}`, store)).toBeNull()
  })

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

describe.skipIf(process.platform === 'win32')('durable writes with a creation mode', () => {
  it('creates the file with the requested mode', () => {
    const { root } = storage()
    const finalPath = join(root, 'state.json')
    writeFileDurableSync(`${finalPath}.tmp`, finalPath, '{}', 0o600)
    expect(statSync(finalPath).mode & 0o777).toBe(0o600)
  })
})

describe('session owner projection hooks', () => {
  function sleeping(paneKey: string): SleepingAgentSessionRecord {
    return {
      paneKey,
      worktreeId: 'repo-1::/srv/app',
      agent: 'claude',
      providerSession: { key: 'session_id', id: paneKey },
      prompt: 'resume me',
      state: 'done',
      capturedAt: 1,
      updatedAt: 1
    }
  }

  it('lets a transfer keep resumable sleeping agents and project focus scalars', () => {
    const source: WorkspaceSessionState = {
      ...getDefaultWorkspaceSession(),
      sleepingAgentSessionsByPaneKey: {
        'tab-1:leaf-1': sleeping('tab-1:leaf-1'),
        'tab-2:leaf-1': sleeping('tab-2:leaf-1')
      }
    }
    const projectSessionFocus = vi.fn()
    const transferred = extractSessionOwnersForTransfer(source, {
      mapOwnerKey: (ownerKey) => ownerKey,
      mapWorktreeId: (id) => id,
      projectSleepingAgentSession: (record) => (record.paneKey === 'tab-1:leaf-1' ? record : null),
      projectSessionFocus
    })
    expect(Object.keys(transferred.sleepingAgentSessionsByPaneKey ?? {})).toEqual(['tab-1:leaf-1'])
    expect(projectSessionFocus).toHaveBeenCalledWith(
      expect.objectContaining({ source, transferred })
    )
  })

  it('drops sleeping agents when the projection does not opt in', () => {
    const transferred = extractSessionOwnersForTransfer(
      {
        ...getDefaultWorkspaceSession(),
        sleepingAgentSessionsByPaneKey: { 'tab-1:leaf-1': sleeping('tab-1:leaf-1') }
      },
      { mapOwnerKey: (ownerKey) => ownerKey, mapWorktreeId: (id) => id }
    )
    expect(transferred.sleepingAgentSessionsByPaneKey).toBeUndefined()
  })
})
