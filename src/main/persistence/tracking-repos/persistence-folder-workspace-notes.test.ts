import {
  closeTestStores,
  testState,
  createStore,
  writeDataFile,
  readDataFile
} from '../persistence-test-harness'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { rmSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { PersistedState } from '../../../shared/persisted-state-types'
import { folderWorkspaceKey } from '../../../shared/workspace-scope'

const { loadUserSshConfigMock, sshConfigHostsToTargetsMock } = vi.hoisted(() => ({
  loadUserSshConfigMock: vi.fn(),
  sshConfigHostsToTargetsMock: vi.fn()
}))

vi.mock('../../ssh/config/ssh-config-parser', () => ({
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

vi.mock('../../telemetry/client', () => ({
  track: trackMock
}))

vi.mock('../../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: getCohortAtEmitMock
}))

describe('Store', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-test-'))
    trackMock.mockReset()
    getCohortAtEmitMock.mockReset()
    getCohortAtEmitMock.mockReturnValue({ nth_repo_added: 2 })
  })

  afterEach(async () => {
    await closeTestStores()
    rmSync(testState.dir, { recursive: true, force: true })
  })

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
          connectionId: null,
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
        : {})
    })
  }

  it('drops the saved note map when the last note is cleared', async () => {
    writeFolderWorkspaceProfile({
      workspaces: [folderWorkspaceRecord()],
      diffCommentsMap: { 'fw-1': [makeFolderNote('note-1', 'Old note')] }
    })

    const store = await createStore()
    // Drain the load's whole save so the edit below saves only what it names.
    store.flush()
    store.updateFolderWorkspace('fw-1', { diffComments: [] })
    store.flush()

    expect((readDataFile() as PersistedState).folderWorkspaceDiffComments).toBeUndefined()
    expect((await createStore()).getFolderWorkspace('fw-1')?.diffComments ?? []).toEqual([])
  })
})
