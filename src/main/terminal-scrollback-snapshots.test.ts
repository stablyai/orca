import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ArchivedTerminalTab } from '../shared/terminal-archive-types'
import { getDefaultWorkspaceSession } from '../shared/constants'
import {
  collectTerminalArchiveScrollbackSnapshotRefs,
  collectTerminalScrollbackSnapshotRefs,
  makeTerminalArchiveScrollbackSnapshotRef,
  makeTerminalScrollbackSnapshotRef,
  readTerminalScrollbackSnapshotSync,
  writeTerminalArchiveScrollbackSnapshotSync
} from './terminal-scrollback-snapshots'

const testState = vi.hoisted(() => ({ root: '' }))

vi.mock('electron', () => ({ app: { getPath: () => testState.root } }))

const ARCHIVE_ID = '11111111-1111-4111-8111-111111111111'
const LEAF_ID = '22222222-2222-4222-8222-222222222222'

describe('terminal scrollback archive references', () => {
  beforeEach(() => {
    testState.root = mkdtempSync(join(tmpdir(), 'orca-scrollback-'))
  })

  afterEach(() => {
    rmSync(testState.root, { recursive: true, force: true })
  })

  it('uses a separate stable namespace for archive refs while sharing the sidecar reader', () => {
    const activeRef = makeTerminalScrollbackSnapshotRef('tab-1', LEAF_ID)
    const archiveRef = makeTerminalArchiveScrollbackSnapshotRef(ARCHIVE_ID, LEAF_ID)
    const storage = { snapshotRoot: join(testState.root, 'terminal-scrollback') }
    const written = writeTerminalArchiveScrollbackSnapshotSync({
      archiveId: ARCHIVE_ID,
      leafId: LEAF_ID,
      buffer: 'archive scrollback',
      storage
    })

    expect(activeRef).toMatch(/^v1-[0-9a-f]{32}$/)
    expect(archiveRef).toMatch(/^v1a-[0-9a-f]{32}$/)
    expect(written).toMatchObject({ kind: 'written', ref: archiveRef })
    expect(readTerminalScrollbackSnapshotSync(archiveRef, storage)).toBe('archive scrollback')
  })

  it('distinguishes a known-empty archive buffer from an archive sidecar write failure', () => {
    const empty = writeTerminalArchiveScrollbackSnapshotSync({
      archiveId: ARCHIVE_ID,
      leafId: LEAF_ID,
      buffer: '',
      storage: { snapshotRoot: join(testState.root, 'terminal-scrollback') }
    })
    const blockedRoot = join(testState.root, 'blocked-snapshot-root')
    writeFileSync(blockedRoot, 'not a directory')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const failed = writeTerminalArchiveScrollbackSnapshotSync({
      archiveId: ARCHIVE_ID,
      leafId: LEAF_ID,
      buffer: 'scrollback',
      storage: { snapshotRoot: blockedRoot }
    })
    warn.mockRestore()

    expect(empty).toEqual({ kind: 'empty' })
    expect(failed).toEqual({ kind: 'failed' })
  })

  it('collects live active and archive refs separately for a shared GC decision', () => {
    const activeRef = makeTerminalScrollbackSnapshotRef('tab-1', LEAF_ID)
    const archiveRef = makeTerminalArchiveScrollbackSnapshotRef(ARCHIVE_ID, LEAF_ID)
    const session = {
      ...getDefaultWorkspaceSession(),
      terminalLayoutsByTabId: {
        'tab-1': {
          root: { type: 'leaf' as const, leafId: LEAF_ID },
          activeLeafId: LEAF_ID,
          expandedLeafId: null,
          scrollbackRefsByLeafId: { [LEAF_ID]: activeRef }
        }
      }
    }
    const archives: Record<string, ArchivedTerminalTab> = {
      [ARCHIVE_ID]: {
        schemaVersion: 1,
        id: ARCHIVE_ID,
        operationId: 'close-1',
        sourceTabId: 'tab-1',
        executionHostId: 'local',
        worktreeId: 'repo-1::/worktree',
        title: 'Terminal',
        layout: {
          root: { type: 'leaf', leafId: LEAF_ID },
          activeLeafId: LEAF_ID,
          expandedLeafId: null
        },
        panesByLeafId: {
          [LEAF_ID]: {
            archivedLeafId: LEAF_ID,
            cwd: '/worktree',
            snapshot: { ref: archiveRef, byteLength: 1, truncated: false, source: 'renderer' }
          }
        },
        reason: 'user-close',
        archivedAt: 1,
        expiresAt: 2,
        restoreCount: 0
      }
    }

    expect(collectTerminalScrollbackSnapshotRefs(session)).toEqual(new Set([activeRef]))
    expect(collectTerminalArchiveScrollbackSnapshotRefs(archives)).toEqual(new Set([archiveRef]))
  })
})
