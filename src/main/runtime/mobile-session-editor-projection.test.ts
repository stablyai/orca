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

function activeOwnedSession(): WorkspaceSessionState {
  return {
    ...ownedSession(),
    activeTabTypeByWorktree: { [WT]: 'editor' },
    activeFileIdByWorktree: { [WT]: ownedEditorFileId(FILE, WT, undefined) }
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

  it('does not list a row mirrored from a paired host', () => {
    const session = ownedSession()
    session.openFilesByWorktree = {
      [WT]: [
        {
          filePath: FILE,
          relativePath: 'notes.ts',
          worktreeId: WT,
          language: 'typescript',
          runtimeEnvironmentId: 'peer',
          mirroredFromRuntimeSession: true
        }
      ]
    }
    expect(buildHeadlessMobileSessionEditorTabs(WT, session)).toEqual([])
  })

  it('shows it as the active file', () => {
    expect(buildHeadlessMobileSessionEditorTabs(WT, activeOwnedSession())).toEqual([
      expect.objectContaining({ id: 'tab-1', isActive: true })
    ])
  })

  it('clears the active file when it retires', () => {
    const retired = retireHeadlessEditorTab(activeOwnedSession(), WT, {
      id: 'tab-1',
      filePath: FILE
    })

    expect(retired?.activeFileIdByWorktree?.[WT]).toBeNull()
  })

  it('keeps matching by path alone with the switch off', () => {
    mocks.layoutOwnerIsMain = false
    expect(buildHeadlessMobileSessionEditorTabs(WT, ownedSession())).toEqual([
      expect.objectContaining({ id: FILE, color: null, isPinned: false })
    ])
  })
})

const ENV = 'env-1'

/** A runtime-environment and a local file at one path: the runtime one listed first and owned. */
function twoOwnerSession(): WorkspaceSessionState {
  const base = ownedSession()
  const file = { filePath: FILE, relativePath: 'notes.ts', worktreeId: WT, language: 'typescript' }
  const tab = base.unifiedTabs![WT]![0]!
  return {
    ...base,
    openFilesByWorktree: {
      [WT]: [{ ...file, runtimeEnvironmentId: ENV, dirtyDraftContent: 'runtime draft' }, file]
    },
    unifiedTabs: {
      [WT]: [
        { ...tab, id: 'tab-local', entityId: FILE, color: null, isPinned: false },
        { ...tab, id: 'tab-runtime', entityId: ownedEditorFileId(FILE, WT, ENV) }
      ]
    },
    tabGroups: {
      [WT]: [
        {
          id: 'group-1',
          worktreeId: WT,
          activeTabId: 'tab-local',
          tabOrder: ['tab-local', 'tab-runtime']
        }
      ]
    },
    activeTabIdByWorktree: { [WT]: 'tab-local' },
    activeTabTypeByWorktree: { [WT]: 'editor' },
    activeFileIdByWorktree: { [WT]: FILE }
  }
}

describe('two owners of one path on a headless host, layout-owner build', () => {
  it("lists each record under its own owner's tab", () => {
    expect(buildHeadlessMobileSessionEditorTabs(WT, twoOwnerSession())).toEqual([
      expect.objectContaining({ id: 'tab-runtime', isDirty: true, isActive: false }),
      expect.objectContaining({ id: 'tab-local', isDirty: false, isActive: true })
    ])
  })

  it('retiring the runtime tab keeps the local record, its tab and the active file', () => {
    const retired = retireHeadlessEditorTab(
      twoOwnerSession(),
      WT,
      { id: 'tab-runtime', filePath: FILE },
      true
    )

    expect(retired?.openFilesByWorktree?.[WT]).toEqual([
      twoOwnerSession().openFilesByWorktree?.[WT]?.[1]
    ])
    expect(retired?.unifiedTabs?.[WT]?.map((tab) => tab.id)).toEqual(['tab-local'])
    expect(retired?.activeFileIdByWorktree?.[WT]).toBe(FILE)
    expect(retired?.activeTabIdByWorktree?.[WT]).toBe('tab-local')
  })

  it("retiring the local tab ignores the runtime record's draft and keeps that record", () => {
    const retired = retireHeadlessEditorTab(twoOwnerSession(), WT, {
      id: 'tab-local',
      filePath: FILE
    })

    expect(retired?.openFilesByWorktree?.[WT]?.map((file) => file.runtimeEnvironmentId)).toEqual([
      ENV
    ])
    expect(retired?.unifiedTabs?.[WT]?.map((tab) => tab.id)).toEqual(['tab-runtime'])
    expect(retired?.activeFileIdByWorktree?.[WT]).toBeNull()
  })

  it('retires nothing for a tab id neither owner is listed under', () => {
    expect(
      retireHeadlessEditorTab(twoOwnerSession(), WT, { id: 'tab-gone', filePath: FILE }, true)
    ).toBeNull()
  })
})
