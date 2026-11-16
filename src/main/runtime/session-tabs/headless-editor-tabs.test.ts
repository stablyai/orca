import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ownedEditorFileId } from '../../../shared/workspace-session/workspace-session-pane-ownership'
import type { WorkspaceSessionState } from '../../../shared/workspace-session/workspace-session-state-types'
import { retireHeadlessEditorTab } from './headless-editor-tabs'

const mocks = vi.hoisted(() => ({ layoutOwnerIsMain: true }))
vi.mock('../../../shared/layout-owner-switch', () => ({
  get ORCA_LAYOUT_OWNER_IS_MAIN() {
    return mocks.layoutOwnerIsMain
  }
}))

beforeEach(() => {
  mocks.layoutOwnerIsMain = true
})

const WT = 'repo-1::/Users/dev/orca'
const FILE = '/Users/dev/orca/notes.ts'

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

const ENV = 'env-1'

// Distinct owners can hold the same path; list the owned runtime file first.
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
})
