import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OrcadMigrationManifest } from '../../../shared/orcad-migration/orcad-migration-manifest'
import { getDefaultWorkspaceSession } from '../../../shared/constants'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { makeTerminalScrollbackSnapshotRef } from '../../terminal-scrollback-snapshots'
import { projectOrcadMigrationSessionScrollback } from '../migrating-orcad-catalog/orcad-source-scrollback-state'
import {
  listWslMoveSleptSessionPanes,
  readWslMoveSleptScrollbackFromHistory,
  sleptScrollbackReader,
  withSleptSessionPanes,
  withSleptSnapshots
} from './wsl-move-slept-scrollback'

const TAB = 'feature-shell'
const LEAF = '11111111-1111-4111-8111-111111111111'
const PANE_KEY = `${TAB}:${LEAF}`
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function spoolRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'wsl-move-slept-'))
  roots.push(root)
  return join(root, 'move-1')
}

function sleptSession(
  extra: Partial<WorkspaceSessionState['terminalLayoutsByTabId'][string]> = {}
) {
  // What Sleep leaves: the layout names the pane, with at most an older renderer buffer.
  return {
    ...getDefaultWorkspaceSession(),
    terminalLayoutsByTabId: {
      [TAB]: {
        root: { type: 'leaf' as const, leafId: LEAF },
        activeLeafId: LEAF,
        expandedLeafId: null,
        ...extra
      }
    }
  } satisfies WorkspaceSessionState
}

function restored(scrollbackAnsi: string, snapshotAnsi: string, hasUnreadableRecovery = false) {
  return {
    status: 'restored' as const,
    sessionId: 'pty-1',
    hasUnreadableRecovery,
    restoreInfo: {
      scrollbackAnsi,
      snapshotAnsi,
      rehydrateSequences: '',
      cwd: '/home/me',
      cols: 80,
      rows: 24,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: unread here.
      modes: {} as never
    }
  }
}

describe('a slept pane on the snapshot channel', () => {
  it('carries the checkpoint a slept pane has instead of a renderer snapshot', () => {
    const history = Buffer.from('$ make\r\nok\r\n$ ', 'utf8')
    // Before the fix the moved terminal opened empty: nothing was carried.
    expect(projectOrcadMigrationSessionScrollback(sleptSession()).snapshots).toEqual([])
    const projected = projectOrcadMigrationSessionScrollback(
      sleptSession(),
      undefined,
      false,
      () => history
    )
    const ref = makeTerminalScrollbackSnapshotRef(TAB, LEAF)
    expect(projected.blockedItems).toEqual([])
    expect(projected.snapshots).toEqual([
      {
        tabId: TAB,
        leafId: LEAF,
        ref,
        sha256: createHash('sha256').update(history).digest('hex'),
        byteLength: history.length
      }
    ])
    expect(projected.session.terminalLayoutsByTabId[TAB]?.scrollbackRefsByLeafId).toEqual({
      [LEAF]: ref
    })
  })

  it('prefers the checkpoint the move just took over an older renderer buffer', () => {
    const history = Buffer.from('newer', 'utf8')
    const projected = projectOrcadMigrationSessionScrollback(
      sleptSession({ buffersByLeafId: { [LEAF]: 'older' } }),
      undefined,
      false,
      () => history
    )
    expect(projected.snapshots[0]?.byteLength).toBe(history.length)
  })

  it('spools each buffer, serves it by ref, and leaves any other ref to the store', async () => {
    const reader = {
      detectColdRestoreState: vi.fn(async () => restored('old\r\n', '$ '))
    }
    const slept = await readWslMoveSleptScrollbackFromHistory(
      reader,
      [{ paneKey: PANE_KEY, sessionId: 'pty-1', wslDistro: 'Ubuntu' }],
      'Ubuntu',
      spoolRoot()
    )
    expect(reader.detectColdRestoreState).toHaveBeenCalledWith('pty-1', {
      ignoreCleanEnd: true,
      wslDistro: 'Ubuntu'
    })
    const bytes = sleptScrollbackReader(slept)?.(TAB, LEAF)
    expect(bytes?.toString('utf8')).toBe('old\r\n$ ')
    const ref = makeTerminalScrollbackSnapshotRef(TAB, LEAF)
    const manifestWith = (sha256: string): OrcadMigrationManifest =>
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the reader reads only these fields.
      ({
        payload: {
          dormantState: {
            terminalScrollbackSnapshots: [{ tabId: TAB, leafId: LEAF, ref, sha256, byteLength: 7 }]
          }
        }
      }) as unknown as OrcadMigrationManifest
    const store = {
      readOrcadMigrationSourceSnapshotChunk: vi.fn(() => ({
        bytesBase64: '',
        totalBytes: 0,
        eof: true
      }))
    }
    const source = withSleptSnapshots(store, slept)
    const signed = manifestWith(createHash('sha256').update(bytes!).digest('hex'))
    expect(source.readOrcadMigrationSourceSnapshotChunk(signed, ref, 3)).toEqual({
      bytesBase64: Buffer.from('\r\n$ ').toString('base64'),
      totalBytes: 7,
      eof: true
    })
    expect(store.readOrcadMigrationSourceSnapshotChunk).not.toHaveBeenCalled()
    source.readOrcadMigrationSourceSnapshotChunk(manifestWith('0'.repeat(64)), ref, 0)
    expect(store.readOrcadMigrationSourceSnapshotChunk).toHaveBeenCalledTimes(1)
    const path = slept.buffers.get(PANE_KEY)?.path
    expect(path && existsSync(path)).toBe(true)
    slept.dispose()
    expect(path && existsSync(path)).toBe(false)
  })

  it('reports a checkpoint it cannot fully read instead of carrying stale history', async () => {
    const reader = {
      detectColdRestoreState: vi.fn(async (sessionId: string) =>
        sessionId === 'pty-1'
          ? restored('old\r\n', '$ ', true)
          : { status: 'unreadable' as const, sessionId }
      )
    }
    const slept = await readWslMoveSleptScrollbackFromHistory(
      reader,
      [
        { paneKey: PANE_KEY, sessionId: 'pty-1' },
        { paneKey: 'other:22222222-1111-4111-8111-111111111111', sessionId: 'pty-2' }
      ],
      'Ubuntu',
      spoolRoot(),
      // awin verify-4: the refusal named the tab by its id.
      (tabId) => (tabId === TAB ? 'build watcher' : null)
    )
    expect(slept.buffers.size).toBe(0)
    expect(slept.problems).toEqual([
      'saved terminal history Orca could not fully read for the tab "build watcher"',
      'saved terminal history Orca could not fully read for the tab other'
    ])
    slept.dispose()
  })
})

describe('panes slept before the move', () => {
  it("lists them from the scope's layouts, live panes first", () => {
    // awin: panes slept earlier in the session had no live terminal, so 0 of 0 were read.
    const session: WorkspaceSessionState = {
      ...sleptSession({ ptyIdsByLeafId: { [LEAF]: 'pty-slept' } }),
      tabsByWorktree: {
        'app::/w': [
          {
            id: TAB,
            ptyId: null,
            worktreeId: 'app::/w',
            title: 't',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          }
        ]
      }
    }
    const slept = listWslMoveSleptSessionPanes(session, ['app::/w'])
    expect(slept).toEqual([{ paneKey: PANE_KEY, sessionId: 'pty-slept' }])
    expect(listWslMoveSleptSessionPanes(session, ['other::/w'])).toEqual([])
    expect(withSleptSessionPanes([{ paneKey: PANE_KEY, sessionId: 'pty-live' }], slept)).toEqual([
      { paneKey: PANE_KEY, sessionId: 'pty-live' }
    ])
  })

  it("takes the window's binding of a pane main retired on Sleep, only for a moved workspace", () => {
    // awin verify-3: with no reload between Sleep and Move, main's layout had no binding left.
    const tab = {
      id: TAB,
      ptyId: null,
      worktreeId: 'app::/w',
      title: 't',
      customTitle: null,
      color: null,
      sortOrder: 0,
      createdAt: 1
    }
    const session: WorkspaceSessionState = {
      ...sleptSession(),
      tabsByWorktree: { 'app::/w': [tab] }
    }
    const minted = 'app::/w@@0b4c'
    expect(listWslMoveSleptSessionPanes(session, ['app::/w'])).toEqual([])
    expect(
      listWslMoveSleptSessionPanes(session, ['app::/w'], [{ paneKey: PANE_KEY, sessionId: minted }])
    ).toEqual([{ paneKey: PANE_KEY, sessionId: minted }])
    for (const reported of [
      { paneKey: PANE_KEY, sessionId: 'other::/w@@0b4c' },
      { paneKey: PANE_KEY, sessionId: '../../etc' },
      { paneKey: `${TAB}:22222222-2222-4222-8222-222222222222`, sessionId: minted },
      { paneKey: `other-tab:${LEAF}`, sessionId: minted }
    ]) {
      expect(listWslMoveSleptSessionPanes(session, ['app::/w'], [reported])).toEqual([])
    }
    expect(
      listWslMoveSleptSessionPanes(
        session,
        ['other::/w'],
        [{ paneKey: PANE_KEY, sessionId: minted }]
      )
    ).toEqual([])
  })
})
