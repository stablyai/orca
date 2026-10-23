// Main's closed-pane record (L80 Q2) is a session field every per-field table must place, and one
// a build that predates it drops without losing anything else.
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { windowViewSaveForMain } from './window-save-view'
import { WORKSPACE_SESSION_FIELD_DISPOSITION } from '../orca-profiles/profile-project-session-field-disposition'
import { WORKSPACE_SESSION_WORKTREE_REFERENCE_KIND } from './restoring-sessions/session-worktree-ownership'
import { WORKSPACE_SESSION_FIELD_OWNERSHIP } from '../../shared/workspace-session-host-field-ownership'
import { SESSION_FIELD_OWNERS } from '../../shared/workspace-layout/workspace-layout-beside'
import { WORKSPACE_SESSION_DISPOSITIONS } from '../../shared/wsl-move/wsl-move-dispositions'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import { parseWorkspaceSession } from '../../shared/workspace-session-schema'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'

vi.mock('../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))

const FIELD = 'closedTerminalPanesByPaneKey'
const ROOT = path.resolve(__dirname, '../../..')

function sourceFiles(dir: string): string[] {
  return readdirSync(path.join(ROOT, dir), { recursive: true, encoding: 'utf8' })
    .filter((file) => file.endsWith('.ts') && !/\.(test|spec)\.ts$|fixture/.test(file))
    .map((file) => path.join(dir, file).split(path.sep).join('/'))
}

const session: WorkspaceSessionState = {
  ...getDefaultWorkspaceSession(),
  closedTerminalPanesByPaneKey: {
    'tab-1:leaf-1': { ptyId: 'pty-1', incarnationId: 'inc-1', worktreeId: 'repo::/w', closedAt: 1 }
  }
}

describe('main’s closed-pane record', () => {
  it.each([
    ['host-field ownership', WORKSPACE_SESSION_FIELD_OWNERSHIP],
    ['WSL move dispositions', WORKSPACE_SESSION_DISPOSITIONS],
    ['profile project dispositions', WORKSPACE_SESSION_FIELD_DISPOSITION],
    ['worktree reference kinds', WORKSPACE_SESSION_WORKTREE_REFERENCE_KIND],
    ['layout field owners', SESSION_FIELD_OWNERS]
  ])('is placed in the %s table', (_name, table) => {
    expect(Object.hasOwn(table, FIELD)).toBe(true)
  })

  it('survives this build’s session parse', () => {
    const parsed = parseWorkspaceSession(session)
    expect(parsed.ok && parsed.value.closedTerminalPanesByPaneKey).toEqual(
      session.closedTerminalPanesByPaneKey
    )
  })

  it('is dropped, alone, by a build that predates it', () => {
    // A build before L80 reads the field as one it does not know: its session parse strips unknown
    // fields and keeps the rest, as this build's does for a field from a newer one.
    const { [FIELD]: records, ...rest } = session
    const asOlder = { ...rest, closedTerminalPanesFromANewerBuild: records }
    const parsed = parseWorkspaceSession(asOlder)
    expect(parsed).toEqual(parseWorkspaceSession(rest))
    expect(parsed.ok && parsed.value).not.toHaveProperty('closedTerminalPanesFromANewerBuild')
  })

  it('is written only by a live edit of main’s layout', () => {
    // Load, restore, a peer's merge and WSL or profile moves never declare a live edit.
    const declaring = [...sourceFiles('src/main'), ...sourceFiles('src/shared')].filter((file) =>
      readFileSync(path.join(ROOT, file), 'utf8').includes("droppedLeafReason: 'live-edit'")
    )
    expect(declaring).toEqual(['src/main/persistence/terminal-topology/terminal-pane-admission.ts'])
  })

  it('is not written by a window save that leaves a bound tab out', () => {
    const leaf = '11111111-1111-4111-8111-111111111111'
    const stored: WorkspaceSessionState = {
      ...getDefaultWorkspaceSession(),
      tabsByWorktree: {
        'repo::/w': [
          {
            id: 'tab-1',
            ptyId: 'pty-1',
            worktreeId: 'repo::/w',
            title: 'Terminal',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          }
        ]
      },
      terminalLayoutsByTabId: {
        'tab-1': {
          root: { type: 'leaf', leafId: leaf },
          activeLeafId: leaf,
          expandedLeafId: null,
          ptyIdsByLeafId: { [leaf]: 'pty-1' }
        }
      },
      terminalPtyIncarnationsByPaneKey: { [`tab-1:${leaf}`]: 'inc-1' }
    }
    const save = { ...stored, tabsByWorktree: { 'repo::/w': [] }, terminalLayoutsByTabId: {} }

    expect(windowViewSaveForMain(stored, save, 'local')).not.toHaveProperty(FIELD)
  })
})
