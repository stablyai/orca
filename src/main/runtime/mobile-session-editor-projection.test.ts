import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ownedEditorFileId } from '../../shared/workspace-session-pane-ownership'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import {
  buildHeadlessMobileSessionEditorTabs,
  retireHeadlessEditorTab
} from './mobile-session-editor-projection'

const mocks = vi.hoisted(() => ({ layoutOwnerIsMain: true }))
vi.mock('../../shared/layout-owner-switch', () => ({
  get ORCA_LAYOUT_OWNER_IS_MAIN() {
    return mocks.layoutOwnerIsMain
  }
}))

beforeEach(() => {
  mocks.layoutOwnerIsMain = true
})

const WT = 'repo-1::/Users/dev/orca'
const FILE = '/Users/dev/orca/notes.ts'

/** A persisted editor tab whose unified tab names its file by the owned id. */
function ownedSession(): WorkspaceSessionState {
  return {
    activeRepoId: null,
    activeWorktreeId: WT,
    activeTabId: null,
    tabsByWorktree: {},
    terminalLayoutsByTabId: {},
    openFilesByWorktree: {
      [WT]: [{ filePath: FILE, relativePath: 'notes.ts', worktreeId: WT, language: 'typescript' }]
    },
    unifiedTabs: {
      [WT]: [
        {
          id: 'tab-1',
          entityId: ownedEditorFileId(FILE, WT, undefined),
          groupId: 'group-1',
          worktreeId: WT,
          contentType: 'editor',
          label: 'notes.ts',
          customLabel: null,
          color: '#ff0000',
          sortOrder: 0,
          createdAt: 0,
          isPinned: true
        }
      ]
    },
    tabGroups: {
      [WT]: [{ id: 'group-1', worktreeId: WT, activeTabId: 'tab-1', tabOrder: ['tab-1'] }]
    }
  }
}

describe('headless editor tabs under an owned id', () => {
  it('lists and retires the unified tab with the layout-owner switch on', () => {
    const session = ownedSession()
    expect(buildHeadlessMobileSessionEditorTabs(WT, session)).toEqual([
      expect.objectContaining({ id: 'tab-1', filePath: FILE, color: '#ff0000', isPinned: true })
    ])
    const retired = retireHeadlessEditorTab(session, WT, { id: 'tab-1', filePath: FILE })
    expect(retired?.unifiedTabs?.[WT]).toEqual([])
    expect(retired?.tabGroups?.[WT]?.[0]?.tabOrder).toEqual([])
  })

  it('keeps matching by path alone with the switch off', () => {
    mocks.layoutOwnerIsMain = false
    expect(buildHeadlessMobileSessionEditorTabs(WT, ownedSession())).toEqual([
      expect.objectContaining({ id: FILE, color: null, isPinned: false })
    ])
  })
})
