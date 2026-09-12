import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { rmSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { PersistedState } from '../shared/persisted-state-types'
import { folderWorkspaceKey } from '../shared/workspace-scope'
import { folderWorkspaceToWorktree } from '../shared/folder-workspace-worktree'
import { testState, createStore, writeDataFile, readDataFile } from './persistence-test-harness'

// Stub the ~/.ssh/config parser so the SSH-import test drives the real Store with deterministic hosts, not the operator's actual ~/.ssh/config.
const { loadUserSshConfigMock, sshConfigHostsToTargetsMock } = vi.hoisted(() => ({
  loadUserSshConfigMock: vi.fn(),
  sshConfigHostsToTargetsMock: vi.fn()
}))

vi.mock('./ssh/ssh-config-parser', () => ({
  loadUserSshConfig: loadUserSshConfigMock,
  sshConfigHostsToTargets: sshConfigHostsToTargetsMock
}))
const { trackMock, getCohortAtEmitMock } = vi.hoisted(() => ({
  trackMock: vi.fn(),
  getCohortAtEmitMock: vi.fn()
}))

vi.mock('electron', () => ({
  app: {
    getPath: () => testState.dir
  },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (plaintext: string) => Buffer.from(`encrypted:${plaintext}`, 'utf-8'),
    decryptString: (ciphertext: Buffer) => {
      const decoded = ciphertext.toString('utf-8')
      if (!decoded.startsWith('encrypted:')) {
        throw new Error('invalid ciphertext')
      }
      return decoded.slice('encrypted:'.length)
    }
  }
}))

vi.mock('./telemetry/client', () => ({
  track: trackMock
}))

vi.mock('./telemetry/cohort-classifier', () => ({
  getCohortAtEmit: getCohortAtEmitMock
}))

describe('Store', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-test-'))
    trackMock.mockReset()
    getCohortAtEmitMock.mockReset()
    getCohortAtEmitMock.mockReturnValue({ nth_repo_added: 2 })
  })

  afterEach(() => {
    rmSync(testState.dir, { recursive: true, force: true })
  })
  // ── 8b. Folder-workspace review notes across a build rollback ──

  function makeFolderNote(id: string, body: string, workspaceId = 'fw-1') {
    return {
      id,
      worktreeId: folderWorkspaceKey(workspaceId),
      filePath: 'README.md',
      source: 'markdown' as const,
      lineNumber: 1,
      body,
      createdAt: 100,
      side: 'modified' as const
    }
  }

  function folderWorkspaceRecord(overrides: Record<string, unknown> = {}) {
    return {
      id: 'fw-1',
      projectGroupId: 'root',
      name: 'Refund fix',
      folderPath: '/workspace/platform',
      linkedTask: null,
      comment: '',
      isArchived: false,
      isUnread: false,
      isPinned: false,
      sortOrder: 10,
      lastActivityAt: 5,
      createdAt: 2,
      updatedAt: 3,
      ...overrides
    }
  }

  function writeFolderWorkspaceProfile(options: {
    workspaces: Record<string, unknown>[]
    diffCommentsMap?: unknown
    connectionId?: string | null
    extraTopLevel?: Record<string, unknown>
  }): void {
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: {},
      ui: {},
      githubCache: { pr: {}, issue: {} },
      projectGroups: [
        {
          id: 'root',
          name: 'Platform',
          parentPath: '/workspace/platform',
          parentGroupId: null,
          connectionId: options.connectionId ?? null,
          createdFrom: 'folder-scan',
          tabOrder: 0,
          isCollapsed: false,
          color: null,
          createdAt: 1,
          updatedAt: 1
        }
      ],
      folderWorkspaces: options.workspaces,
      ...('diffCommentsMap' in options
        ? { folderWorkspaceDiffComments: options.diffCommentsMap }
        : {}),
      ...options.extraTopLevel
    })
  }

  // The previous build's normalizeFolderWorkspaces has no diffComments projection (the line this
  // checkout carries at src/shared/folder-workspaces.ts:107 does not exist on v1.4.179–v1.4.181),
  // and its full-state write re-serializes everything else verbatim (the `{ ...defaults, ...parsed }`
  // load spread and the omit-style getDurableState()).
  function simulatePreviousBuildLoadAndFlush(onDisk: PersistedState): PersistedState {
    return {
      ...onDisk,
      folderWorkspaces: onDisk.folderWorkspaces.map(
        ({ diffComments: _droppedByOldNormalizer, ...rest }) => rest
      )
    }
  }

  it('keeps folder-workspace review notes across a previous-build rollback and re-upgrade', async () => {
    const store = await createStore()
    const group = store.createProjectGroup({
      name: 'Platform',
      parentPath: '/workspace/platform',
      createdFrom: 'folder-scan'
    })
    const workspace = store.createFolderWorkspace({
      projectGroupId: group.id,
      name: 'Refund fix'
    })
    const note = makeFolderNote('note-1', 'Review this paragraph', workspace.id)
    store.updateFolderWorkspace(workspace.id, { diffComments: [note] })
    store.flush()

    const persisted = readDataFile() as PersistedState
    expect(persisted.folderWorkspaceDiffComments?.[workspace.id]).toEqual([note])
    expect(persisted.folderWorkspaces[0]).not.toHaveProperty('diffComments')
    // The strip lives at the serialization boundary only; live records keep their notes.
    expect(store.getFolderWorkspace(workspace.id)?.diffComments).toEqual([note])
    expect(folderWorkspaceToWorktree(store.getFolderWorkspace(workspace.id)!).diffComments).toEqual(
      [note]
    )

    writeDataFile(simulatePreviousBuildLoadAndFlush(persisted))

    const restored = await createStore()
    expect(restored.getFolderWorkspace(workspace.id)?.diffComments).toEqual([note])
    restored.flush()
    expect((readDataFile() as PersistedState).folderWorkspaceDiffComments?.[workspace.id]).toEqual([
      note
    ])
  })

  it('survives repeated rollback / re-upgrade hops', async () => {
    const store = await createStore()
    const group = store.createProjectGroup({
      name: 'Platform',
      parentPath: '/workspace/platform',
      createdFrom: 'folder-scan'
    })
    const workspace = store.createFolderWorkspace({ projectGroupId: group.id, name: 'Refund fix' })
    const note = makeFolderNote('note-1', 'Review this paragraph', workspace.id)
    store.updateFolderWorkspace(workspace.id, { diffComments: [note] })
    store.flush()

    for (let hop = 0; hop < 2; hop++) {
      writeDataFile(simulatePreviousBuildLoadAndFlush(readDataFile() as PersistedState))
      const reupgraded = await createStore()
      expect(reupgraded.getFolderWorkspace(workspace.id)?.diffComments).toEqual([note])
      reupgraded.flush()
    }
  })

  it('keeps notes and remote provenance for an SSH folder workspace across a rollback', async () => {
    const store = await createStore()
    const group = store.createProjectGroup({
      name: 'Platform',
      parentPath: '/workspace/platform',
      connectionId: 'ssh-1',
      createdFrom: 'folder-scan'
    })
    const workspace = store.createFolderWorkspace({ projectGroupId: group.id, name: 'Remote fix' })
    expect(workspace.connectionId).toBe('ssh-1')
    const note = makeFolderNote('note-remote', 'Remote review', workspace.id)
    store.updateFolderWorkspace(workspace.id, { diffComments: [note] })
    store.flush()

    writeDataFile(simulatePreviousBuildLoadAndFlush(readDataFile() as PersistedState))

    const restored = await createStore()
    expect(restored.getFolderWorkspace(workspace.id)?.diffComments).toEqual([note])
    expect(restored.getFolderWorkspace(workspace.id)?.connectionId).toBe('ssh-1')
  })

  it('round-trips unknown top-level state keys through load and flush', async () => {
    writeFolderWorkspaceProfile({
      workspaces: [folderWorkspaceRecord({ unknownNestedField: 'from-a-newer-build' })],
      extraTopLevel: { unknownTopLevelKey: { kept: 'verbatim' } }
    })

    const store = await createStore()
    store.updateFolderWorkspace('fw-1', { comment: 'touch' })
    store.flush()

    const persisted = readDataFile() as PersistedState & { unknownTopLevelKey?: unknown }
    expect(
      persisted.unknownTopLevelKey,
      'Unknown top-level keys must survive load + flush. Note preservation relies on this: converting the ' +
        '`{ ...defaults, ...parsed }` load spread or the omit-style getDurableState() into an ' +
        'allowlist re-opens folder-workspace note loss for the then-previous build.'
    ).toEqual({ kept: 'verbatim' })
    expect(
      persisted.folderWorkspaces[0],
      'Documents existing behavior, not a guarantee: normalizeFolderWorkspaces rebuilds each ' +
        'record field-by-field, so nested unknown fields are dropped. That is why notes moved ' +
        'to a top-level key.'
    ).not.toHaveProperty('unknownNestedField')
  })

  it('migrates legacy inline folder-workspace notes into the top-level map', async () => {
    const note = makeFolderNote('note-1', 'Legacy inline note')
    writeFolderWorkspaceProfile({ workspaces: [folderWorkspaceRecord({ diffComments: [note] })] })

    const store = await createStore()
    expect(store.getFolderWorkspace('fw-1')?.diffComments).toEqual([note])
    store.flush()

    const persisted = readDataFile() as PersistedState
    expect(persisted.folderWorkspaceDiffComments?.['fw-1']).toEqual([note])
    expect(persisted.folderWorkspaces[0]).not.toHaveProperty('diffComments')
  })

  it('keeps notes across a rollback when the session never edits anything', async () => {
    const note = makeFolderNote('note-1', 'Legacy inline note')
    writeFolderWorkspaceProfile({ workspaces: [folderWorkspaceRecord({ diffComments: [note] })] })

    // Launch and quit on the fixed build, with no mutation: loadNeedsSave must make the
    // relocation durable on its own. This is the reported P0 sequence.
    const upgraded = await createStore()
    upgraded.flush()

    writeDataFile(simulatePreviousBuildLoadAndFlush(readDataFile() as PersistedState))

    const restored = await createStore()
    expect(restored.getFolderWorkspace('fw-1')?.diffComments).toEqual([note])
  })

  it('keeps notes authored inline on a rolled-back #14112 build over a staler map entry', async () => {
    const mapped = makeFolderNote('note-mapped', 'Note from the fixed build')
    const authored = makeFolderNote('note-inline', 'Note authored while rolled back')

    writeFolderWorkspaceProfile({
      workspaces: [folderWorkspaceRecord()],
      diffCommentsMap: { 'fw-1': [mapped] }
    })
    // #14112 persists notes inline and never learned about the top-level map, so a note authored
    // there lands inline while the untouched map entry goes stale. Inline is the newer write.
    const rolledBack = readDataFile() as PersistedState
    writeDataFile({
      ...rolledBack,
      folderWorkspaces: rolledBack.folderWorkspaces.map((workspace) => ({
        ...workspace,
        diffComments: [authored]
      }))
    })

    const store = await createStore()
    expect(store.getFolderWorkspace('fw-1')?.diffComments).toEqual([authored])
    store.flush()
    expect((readDataFile() as PersistedState).folderWorkspaceDiffComments).toEqual({
      'fw-1': [authored]
    })
  })

  it('never lets an empty or unrelated map entry delete inline notes', async () => {
    const inline = makeFolderNote('note-inline', 'Inline note')
    const mapped = makeFolderNote('note-mapped', 'Mapped note')

    writeFolderWorkspaceProfile({
      workspaces: [folderWorkspaceRecord({ diffComments: [inline] })],
      diffCommentsMap: { 'fw-1': [] }
    })
    expect((await createStore()).getFolderWorkspace('fw-1')?.diffComments).toEqual([inline])

    writeFolderWorkspaceProfile({
      workspaces: [folderWorkspaceRecord({ diffComments: [inline] })],
      diffCommentsMap: { other: [mapped] }
    })
    const store = await createStore()
    expect(store.getFolderWorkspace('fw-1')?.diffComments).toEqual([inline])
    store.flush()
    expect((readDataFile() as PersistedState).folderWorkspaceDiffComments).toEqual({
      'fw-1': [inline]
    })
  })

  it('drops orphaned note entries and prunes them when workspaces are deleted', async () => {
    const note = makeFolderNote('note-1', 'Kept note')
    writeFolderWorkspaceProfile({
      workspaces: [folderWorkspaceRecord()],
      diffCommentsMap: { 'fw-1': [note], ghost: [makeFolderNote('note-ghost', 'Orphan', 'ghost')] }
    })

    const store = await createStore()
    store.flush()
    expect((readDataFile() as PersistedState).folderWorkspaceDiffComments).toEqual({
      'fw-1': [note]
    })

    const reloaded = await createStore()
    reloaded.flush()
    expect((readDataFile() as PersistedState).folderWorkspaceDiffComments).not.toHaveProperty(
      'ghost'
    )

    // Delete paths carry no pruning code: the map is derived from live workspaces on every write.
    expect(reloaded.removeFolderWorkspace('fw-1')).toBe(true)
    reloaded.flush()
    expect(readDataFile() as PersistedState).not.toHaveProperty('folderWorkspaceDiffComments')

    writeFolderWorkspaceProfile({
      workspaces: [folderWorkspaceRecord()],
      diffCommentsMap: { 'fw-1': [note] }
    })
    const groupDelete = await createStore()
    expect(groupDelete.deleteProjectGroup('root')).toBe(true)
    groupDelete.flush()
    expect(readDataFile() as PersistedState).not.toHaveProperty('folderWorkspaceDiffComments')
  })

  it('writes no folderWorkspaceDiffComments key for note-free profiles', async () => {
    const store = await createStore()
    const group = store.createProjectGroup({
      name: 'Platform',
      parentPath: '/workspace/platform',
      createdFrom: 'folder-scan'
    })
    const workspace = store.createFolderWorkspace({ projectGroupId: group.id, name: 'No notes' })
    store.flush()
    expect('folderWorkspaceDiffComments' in (readDataFile() as object)).toBe(false)

    store.updateFolderWorkspace(workspace.id, { diffComments: [] })
    store.flush()
    expect('folderWorkspaceDiffComments' in (readDataFile() as object)).toBe(false)
  })

  it.each([
    ['null root', null, undefined],
    ['string root', 'oops', undefined],
    ['array root', [], undefined],
    ['non-array entry value', { 'fw-1': 'oops' }, undefined],
    ['array of non-DiffComment members', { 'fw-1': [7] }, [7]]
  ])(
    'tolerates a corrupt folderWorkspaceDiffComments map (%s)',
    async (_label, diffCommentsMap, expected) => {
      writeFolderWorkspaceProfile({ workspaces: [folderWorkspaceRecord()], diffCommentsMap })

      const store = await createStore()

      expect(store.getFolderWorkspace('fw-1')?.diffComments).toEqual(expected)
    }
  )

  it('passes note members through verbatim on load and re-write', async () => {
    // Shape-only guard: the moment member filtering is added here, the fix itself becomes a new
    // deletion path for user-authored prose.
    const noteWithExtras = { ...makeFolderNote('note-1', 'Body'), unknownNoteField: 'kept' }
    writeFolderWorkspaceProfile({
      workspaces: [folderWorkspaceRecord(), folderWorkspaceRecord({ id: 'fw-2', name: 'Second' })],
      diffCommentsMap: { 'fw-1': [7], 'fw-2': [noteWithExtras] }
    })

    const store = await createStore()
    store.flush()

    const persisted = readDataFile() as PersistedState
    expect(persisted.folderWorkspaceDiffComments).toEqual({
      'fw-1': [7],
      'fw-2': [noteWithExtras]
    })
  })

  it('derives the written note map from live workspaces, never a stale loaded copy', async () => {
    const loadedNote = makeFolderNote('note-loaded', 'Loaded note')
    const editedNote = makeFolderNote('note-edited', 'Edited note')
    writeFolderWorkspaceProfile({
      workspaces: [folderWorkspaceRecord()],
      diffCommentsMap: { 'fw-1': [loadedNote] }
    })

    const store = await createStore()
    store.updateFolderWorkspace('fw-1', { diffComments: [editedNote] })
    store.flush()

    expect((readDataFile() as PersistedState).folderWorkspaceDiffComments).toEqual({
      'fw-1': [editedNote]
    })
  })
})
