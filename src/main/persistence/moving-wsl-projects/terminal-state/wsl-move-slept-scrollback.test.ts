import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { getDefaultWorkspaceSession } from '../../../../shared/constants'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session/workspace-session-state-types'
import type { TerminalModes } from '../../../daemon/protocol/terminal-modes'
import { parseOrcadMigrationTerminalHistoryText } from '../../../../shared/orcad-migration/orcad-migration-terminal-history'
import {
  daemonHistoryLeafOf,
  listWslMoveSleptSessionPanes,
  readWslMoveSleptScrollbackFromHistory
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

  // The redesign's contract: what the host's daemon cold-restores is what this desktop's would.
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

describe('panes slept before the move', () => {
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
