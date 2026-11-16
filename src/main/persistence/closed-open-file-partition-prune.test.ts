import { describe, expect, it } from 'vitest'
import type {
  PersistedOpenFile,
  WorkspaceSessionState
} from '../../shared/workspace-session/workspace-session-state-types'
import {
  pruneClosedOpenFileAcrossPartitions,
  pruneClosedOpenFileFromSlice
} from './closed-open-file-partition-prune'
const WORKTREE = 'wt-1'
const FILE_A = '/repo/notes.md'
const FILE_B = '/repo/other.md'

function persistedOpenFile(overrides: Partial<PersistedOpenFile>): PersistedOpenFile {
  return {
    filePath: FILE_A,
    relativePath: 'notes.md',
    worktreeId: WORKTREE,
    language: 'markdown',
    ...overrides
  }
}

function sessionSlice(openFiles: PersistedOpenFile[]): WorkspaceSessionState {
  return {
    activeRepoId: null,
    activeWorktreeId: null,
    activeTabId: null,
    tabsByWorktree: {},
    terminalLayoutsByTabId: {},
    openFilesByWorktree: { [WORKTREE]: openFiles }
  }
}

function partitionStore(partitions: Record<string, WorkspaceSessionState>) {
  const writes: { hostId: string; state: WorkspaceSessionState }[] = []
  return {
    writes,
    io: {
      hostIds: Object.keys(partitions),
      read: (hostId: string) => partitions[hostId],
      write: (state: WorkspaceSessionState, hostId: string) => {
        partitions[hostId] = state
        writes.push({ hostId, state })
      }
    }
  }
}

describe('pruneClosedOpenFileFromSlice', () => {
  it('drops only the closed file, keeping sibling files and other worktrees', () => {
    const mine = persistedOpenFile({ dirtyDraftContent: 'unsaved' })
    const sibling = persistedOpenFile({ filePath: FILE_B, relativePath: 'other.md' })
    const otherWorktreeRow = persistedOpenFile({
      worktreeId: 'wt-2',
      filePath: FILE_A,
      relativePath: 'notes.md'
    })
    const slice: WorkspaceSessionState = {
      ...sessionSlice([mine, sibling]),
      openFilesByWorktree: { [WORKTREE]: [mine, sibling], 'wt-2': [otherWorktreeRow] }
    }

    const pruned = pruneClosedOpenFileFromSlice(slice, { worktreeId: WORKTREE, filePath: FILE_A })

    expect(pruned?.openFilesByWorktree).toEqual({
      [WORKTREE]: [sibling],
      'wt-2': [otherWorktreeRow]
    })
  })

  it('removes an emptied worktree key', () => {
    const pruned = pruneClosedOpenFileFromSlice(sessionSlice([persistedOpenFile({})]), {
      worktreeId: WORKTREE,
      filePath: FILE_A
    })
    expect(pruned?.openFilesByWorktree).toEqual({})
  })

  it('returns null when the partition does not hold the file', () => {
    expect(
      pruneClosedOpenFileFromSlice(sessionSlice([persistedOpenFile({ filePath: FILE_B })]), {
        worktreeId: WORKTREE,
        filePath: FILE_A
      })
    ).toBeNull()
  })
})

describe('pruneClosedOpenFileAcrossPartitions', () => {
  it('two sequential closes never restore each other (lost update)', () => {
    // Regression for the renderer-side race CodeRabbit flagged: two closes reading the same
    // snapshot used to have the second write restore the first prune. One main-side call per
    // close reads and writes inside the same invocation, so B's read sees A already gone.
    const store = partitionStore({
      local: sessionSlice([]),
      'ssh:legacy': sessionSlice([
        persistedOpenFile({ filePath: FILE_A, dirtyDraftContent: 'a' }),
        persistedOpenFile({ filePath: FILE_B, relativePath: 'other.md', dirtyDraftContent: 'b' })
      ])
    })

    pruneClosedOpenFileAcrossPartitions(store.io, { worktreeId: WORKTREE, filePath: FILE_A })
    pruneClosedOpenFileAcrossPartitions(store.io, { worktreeId: WORKTREE, filePath: FILE_B })

    expect(store.writes).toHaveLength(2)
    expect(store.writes[0]?.state.openFilesByWorktree?.[WORKTREE]).toEqual([
      persistedOpenFile({ filePath: FILE_B, relativePath: 'other.md', dirtyDraftContent: 'b' })
    ])
    expect(store.writes[1]?.state.openFilesByWorktree?.[WORKTREE]).toBeUndefined()
  })

  it('prunes the row from every holding partition and skips partitions without it', () => {
    const store = partitionStore({
      local: sessionSlice([]),
      'ssh:legacy': sessionSlice([persistedOpenFile({ dirtyDraftContent: 'unsaved' })]),
      'runtime:env': sessionSlice([
        persistedOpenFile({ mirroredFromRuntimeSession: true })
      ])
    })

    pruneClosedOpenFileAcrossPartitions(store.io, { worktreeId: WORKTREE, filePath: FILE_A })

    expect(store.writes.map((write) => write.hostId).sort()).toEqual(['runtime:env', 'ssh:legacy'])
    expect(store.writes[0]?.state.openFilesByWorktree?.[WORKTREE]).toBeUndefined()
    expect(store.writes[1]?.state.openFilesByWorktree?.[WORKTREE]).toBeUndefined()
  })
})
