import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../../../shared/constants'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { getHistorySessionDirName } from '../../daemon/history-paths'
import { HistoryReader } from '../../daemon/history-reader'
import type { TerminalModes } from '../../daemon/terminal-modes'
import { projectOrcadMigrationSessionScrollback } from '../migrating-orcad-catalog/orcad-source-scrollback-state'
import { parseOrcadMigrationTerminalHistoryText } from '../../../shared/orcad-migration/orcad-migration-terminal-history'
import {
  installOrcadMigrationTerminalHistory,
  movedPaneHistorySessionId,
  orcadMigrationTerminalHistoryKey
} from '../migrating-orcad-catalog/orcad-terminal-history-installer'
import { getOrcadMigrationReceivedBlobPath } from '../migrating-orcad-catalog/orcad-migration-blob-staging'
import {
  daemonHistoryLeafOf,
  listWslMoveSleptSessionPanes,
  readWslMoveSleptScrollbackFromHistory,
  withSleptSessionPanes,
  wslMoveTerminalHistoryBlobs
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

function modes(alternateScreen: boolean): TerminalModes {
  return { bracketedPaste: false, mouseTracking: false, applicationCursor: false, alternateScreen }
}

function withModes<T extends ReturnType<typeof restored>>(
  detection: T,
  alternateScreen: boolean
): T {
  return {
    ...detection,
    restoreInfo: {
      ...detection.restoreInfo,
      modes: {
        bracketedPaste: false,
        mouseTracking: false,
        applicationCursor: false,
        alternateScreen
      } satisfies TerminalModes
    }
  }
}

describe("a paused pane's daemon history", () => {
  it('leaves the pane out of the snapshot channel: the host restores it, nothing else paints it', () => {
    const projected = projectOrcadMigrationSessionScrollback(
      sleptSession({ buffersByLeafId: { [LEAF]: 'older' } }),
      undefined,
      false,
      () => true
    )
    expect(projected.blockedItems).toEqual([])
    expect(projected.snapshots).toEqual([])
    expect(projected.session.terminalLayoutsByTabId[TAB]?.scrollbackRefsByLeafId).toBeUndefined()
  })

  // A normal-screen restore holds the whole buffer in both fields; carried twice,
  // the per-pane cap then kept only the newest ~half of a 2,000-line pane.
  it('writes a normal-screen buffer once, so a 2,000-line pane arrives whole', async () => {
    const buffer = Array.from({ length: 2_000 }, (_, i) => `line ${i}`).join('\r\n')
    const slept = await readWslMoveSleptScrollbackFromHistory(
      { detectColdRestoreState: async () => withModes(restored(buffer, buffer), false) },
      [{ paneKey: PANE_KEY, sessionId: 'pty-1', wslDistro: 'Ubuntu' }],
      'Ubuntu',
      spoolRoot()
    )
    const document = documentOf(slept)
    expect(document.checkpoint.snapshotAnsi).toBe(`${buffer}\r\n`)
    expect(document.checkpoint.scrollbackAnsi).toBe('')
    expect(daemonHistoryLeafOf(slept)?.(TAB, LEAF)).toBe(true)
    slept.dispose()
  })

  it("keeps the normal buffer behind a TUI and the shell's last folder", async () => {
    const slept = await readWslMoveSleptScrollbackFromHistory(
      {
        detectColdRestoreState: async () =>
          withModes(restored('$ make\r\nok\r\n', 'TUI FRAME'), true)
      },
      [
        { paneKey: PANE_KEY, sessionId: 'pty-1', wslDistro: 'Ubuntu', shellCwd: '/home/me/deep/er' }
      ],
      'Ubuntu',
      spoolRoot()
    )
    const document = documentOf(slept)
    expect(document.cwd).toBe('/home/me/deep/er')
    expect(document.checkpoint.cwd).toBe('/home/me/deep/er')
    expect(document.checkpoint.scrollbackAnsi).toBe('$ make\r\nok\r\n')
    slept.dispose()
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
      (tabId) => (tabId === TAB ? 'build watcher' : null)
    )
    expect(slept.buffers.size).toBe(0)
    expect(slept.problems).toEqual([
      'saved terminal history Orca could not fully read for the tab "build watcher"',
      'saved terminal history Orca could not fully read for the tab other'
    ])
    slept.dispose()
  })

  // The redesign's contract: what the host's daemon cold-restores is what this desktop's would.
  it('round-trips: the host restores the same history, in the shell folder, from its own daemon', async () => {
    const source = historyRoot()
    const lines = Array.from({ length: 2_000 }, (_, i) => `line ${i}`).join('\r\n')
    writeSourceSession(source, 'pty-1', lines, '/home/me/deep')
    const slept = await readWslMoveSleptScrollbackFromHistory(
      new HistoryReader(source),
      [{ paneKey: PANE_KEY, sessionId: 'pty-1', wslDistro: 'Ubuntu' }],
      'Ubuntu',
      spoolRoot()
    )
    const blobs = wslMoveTerminalHistoryBlobs(slept, { payload: manifestFor() })
    expect(blobs.descriptors).toEqual([
      expect.objectContaining({
        blobKind: 'terminal-history',
        key: orcadMigrationTerminalHistoryKey(PANE_KEY)
      })
    ])
    const migration = { migrationId: 'move-1', manifestSha256: 'a'.repeat(64) }
    const received = historyRoot()
    const descriptor = blobs.descriptors[0]!
    const path = getOrcadMigrationReceivedBlobPath(received, migration, descriptor)
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, await blobs.source.readChunk(descriptor, 0, descriptor.byteLength))
    slept.dispose()

    const host = historyRoot()
    const worktreeId = 'repo::/home/me'
    const install = {
      migration,
      root: received,
      historyRoot: host,
      paneWorktreeId: () => worktreeId,
      workspacePath: () => '/home/me',
      now: Date.parse('2026-10-23T00:00:00.000Z')
    }
    installOrcadMigrationTerminalHistory(install)
    const sessionId = movedPaneHistorySessionId(worktreeId, PANE_KEY)
    const reader = new HistoryReader(host)
    expect(reader.probeRestorableHistory(sessionId)).toEqual({ status: 'restorable', sessionId })
    const restoredHere = await reader.detectColdRestoreState(sessionId)
    expect(restoredHere.status).toBe('restored')
    if (restoredHere.status !== 'restored') {
      return
    }
    expect(restoredHere.restoreInfo.snapshotAnsi).toBe(`${lines}\r\n`)
    expect(restoredHere.restoreInfo.cwd).toBe('/home/me/deep')

    // A retry after the pane started never rewinds it to the moved history.
    writeFileSync(
      join(host, getHistorySessionDirName(sessionId), 'meta.json'),
      JSON.stringify({ ...readMeta(host, sessionId), endedAt: '2026-10-23T00:01:00.000Z' })
    )
    writeFileSync(path, 'stale retry')
    installOrcadMigrationTerminalHistory(install)
    expect(reader.probeRestorableHistory(sessionId)).toEqual({ status: 'none' })
  })
})

function documentOf(slept: Awaited<ReturnType<typeof readWslMoveSleptScrollbackFromHistory>>) {
  const entry = slept.buffers.get(PANE_KEY)
  if (!entry) {
    throw new Error('expected a history document')
  }
  const document = parseOrcadMigrationTerminalHistoryText(readFileSync(entry.path, 'utf8'))
  return {
    ...document,
    checkpoint: {
      snapshotAnsi: String(document.checkpoint.snapshotAnsi),
      scrollbackAnsi: String(document.checkpoint.scrollbackAnsi),
      cwd: document.checkpoint.cwd
    }
  }
}

function manifestFor(): { dormantState: { workspaceSession: WorkspaceSessionState } } {
  return { dormantState: { workspaceSession: sleptSession() } }
}

function historyRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'wsl-move-history-'))
  roots.push(root)
  return root
}

function writeSourceSession(root: string, sessionId: string, buffer: string, cwd: string): void {
  const dir = join(root, getHistorySessionDirName(sessionId))
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'checkpoint.json'),
    JSON.stringify({
      snapshotAnsi: buffer,
      scrollbackAnsi: '',
      rehydrateSequences: '',
      cwd,
      cols: 80,
      rows: 24,
      modes: modes(false),
      scrollbackLines: 2_000,
      checkpointedAt: '2026-10-22T00:00:00.000Z'
    })
  )
  // What Sleep leaves: a cleanly ended session.
  writeFileSync(
    join(dir, 'meta.json'),
    JSON.stringify({
      cwd: '/home/me',
      cols: 80,
      rows: 24,
      startedAt: '2026-10-22T00:00:00.000Z',
      endedAt: '2026-10-22T00:00:01.000Z',
      exitCode: 0
    })
  )
}

function readMeta(root: string, sessionId: string): Record<string, unknown> {
  const value: unknown = JSON.parse(
    readFileSync(join(root, getHistorySessionDirName(sessionId), 'meta.json'), 'utf8')
  )
  return value && typeof value === 'object' ? { ...value } : {}
}

describe('panes slept before the move', () => {
  it("lists them from the scope's layouts, live panes first", () => {
    // Panes slept earlier in the session had no live terminal, so 0 of 0 were read.
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
    // With no reload between Sleep and Move, main's layout had no binding left.
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
