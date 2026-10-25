import { describe, expect, it, vi } from 'vitest'
import type { FolderWorkspace } from '../../shared/folder-workspace-types'
import type { MemorySnapshotStore } from './collector'
import { resolveWorktreeMemoryNames } from './memory-snapshot-buckets'

const folder: FolderWorkspace = {
  id: 'notes-folder',
  projectGroupId: 'documentation',
  name: 'Release notes',
  folderPath: '/notes',
  linkedTask: null,
  comment: '',
  isArchived: false,
  isUnread: false,
  isPinned: false,
  sortOrder: 0,
  lastActivityAt: 0,
  createdAt: 0,
  updatedAt: 0
}
const group = { id: 'documentation', name: 'Documentation' }

function makeStore(): MemorySnapshotStore &
  Required<Pick<MemorySnapshotStore, 'getFolderWorkspace' | 'getProjectGroups'>> {
  return {
    getRepo: vi.fn(),
    getWorktreeMeta: vi.fn(),
    getFolderWorkspace: vi.fn((id) => (id === folder.id ? folder : undefined)),
    getProjectGroups: vi.fn(() => [group])
  }
}

describe('memory snapshot workspace names', () => {
  it('resolves a folder workspace and its project group from persisted metadata', () => {
    const store = makeStore()
    expect(resolveWorktreeMemoryNames('folder:notes-folder', store)).toEqual({
      worktreeName: 'Release notes',
      repoId: 'folder-workspace:documentation',
      repoName: 'Documentation'
    })
    expect(store.getRepo).not.toHaveBeenCalled()
  })

  it('reads updated folder and project-group names on the next snapshot', () => {
    const store = makeStore()
    resolveWorktreeMemoryNames('folder:notes-folder', store)
    vi.mocked(store.getFolderWorkspace).mockReturnValue({ ...folder, name: 'Changelog' })
    vi.mocked(store.getProjectGroups).mockReturnValue([{ ...group, name: 'Docs' }])
    expect(resolveWorktreeMemoryNames('folder:notes-folder', store)).toMatchObject({
      worktreeName: 'Changelog',
      repoName: 'Docs'
    })
  })

  it('keeps a readable folder label if its project-group metadata is missing', () => {
    const store = makeStore()
    vi.mocked(store.getProjectGroups).mockReturnValue([])
    expect(resolveWorktreeMemoryNames('folder:notes-folder', store)).toMatchObject({
      worktreeName: 'Release notes',
      repoName: 'Release notes'
    })
  })

  it('keeps unknown folder ids identifiable without assigning them to a different folder', () => {
    expect(resolveWorktreeMemoryNames('folder:missing', makeStore())).toEqual({
      worktreeName: 'folder:missing',
      repoId: 'folder:missing',
      repoName: 'folder:missing'
    })
  })

  it('preserves the git worktree name fallback', () => {
    expect(resolveWorktreeMemoryNames('repo::/work/fix', makeStore())).toEqual({
      worktreeName: 'fix',
      repoId: 'repo',
      repoName: 'repo'
    })
  })
})

describe('memory snapshot optional capability failures', () => {
  it('keeps the direct folder call failure when that capability is absent', () => {
    const store: MemorySnapshotStore = { getRepo: vi.fn(), getWorktreeMeta: vi.fn() }
    expect(() => resolveWorktreeMemoryNames('folder:notes-folder', store)).toThrow(TypeError)
    expect(store.getRepo).not.toHaveBeenCalled()
    expect(store.getWorktreeMeta).not.toHaveBeenCalled()
  })

  it('keeps the direct group call failure after the folder lookup', () => {
    const getFolderWorkspace = vi.fn(() => folder)
    const store: MemorySnapshotStore = {
      getRepo: vi.fn(),
      getWorktreeMeta: vi.fn(),
      getFolderWorkspace
    }
    expect(() => resolveWorktreeMemoryNames('folder:notes-folder', store)).toThrow(TypeError)
    expect(getFolderWorkspace).toHaveBeenCalledExactlyOnceWith(folder.id)
    expect(store.getRepo).not.toHaveBeenCalled()
  })

  it('looks up and invokes folder before groups with the original receiver and arguments', () => {
    const calls: string[] = []
    const store: MemorySnapshotStore = {
      getRepo: vi.fn(),
      getWorktreeMeta: vi.fn(),
      get getFolderWorkspace() {
        calls.push('folder:get')
        return function (this: MemorySnapshotStore, id: string) {
          expect(this).toBe(store)
          expect(arguments.length).toBe(1)
          expect(id).toBe(folder.id)
          calls.push('folder:call')
          return folder
        }
      },
      get getProjectGroups() {
        calls.push('groups:get')
        return function (this: MemorySnapshotStore) {
          expect(this).toBe(store)
          expect(arguments.length).toBe(0)
          calls.push('groups:call')
          return [group]
        }
      }
    }
    expect(resolveWorktreeMemoryNames('folder:notes-folder', store).repoName).toBe(group.name)
    expect(calls).toEqual(['folder:get', 'folder:call', 'groups:get', 'groups:call'])
  })
})
