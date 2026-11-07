import {
  closeTestStores,
  testState,
  createStore,
  writeDataFile,
  readDataFile,
  makeRepo
} from '../persistence-test-harness'
import { makeTerminalTab } from '../persistence-session-fixtures'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { rmSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { PersistedState } from '../../../shared/persisted-state-types'
import { getDefaultWorkspaceSession } from '../../../shared/constants'
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

  it('drops corrupt worktreeMeta entries while still normalizing valid siblings', async () => {
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeLineageById: { 'r1::/tmp/wt': { parentWorktreeId: 'wt-sibling' } },
      workspaceLineageByChildKey: {
        'worktree:r1::/tmp/wt': { parentWorkspaceKey: 'worktree:wt-sibling' }
      },
      worktreeMeta: {
        'r1::/tmp/wt': null,
        'r1::/tmp/scalar': 5,
        'wt-sibling': {
          linkedWorkItem: {
            provider: 'jira',
            type: 'issue',
            number: 0,
            title: 'ORCA-123 Link Jira',
            url: 'https://company.atlassian.net/browse/ORCA-123',
            jiraIdentifier: 'ORCA-123'
          },
          linkedTaskSourceContext: {
            kind: 'task-source',
            provider: 'jira',
            projectId: 'project-1',
            hostId: 'local',
            accountLabel: 44,
            providerIdentity: {
              provider: 'jira',
              siteId: 'site-1',
              siteUrl: 'https://company.atlassian.net',
              projectKey: 'ORCA'
            }
          }
        }
      }
    })

    const store = await createStore()

    expect(store.getWorktreeMeta('wt-sibling')?.linkedWorkItem?.jiraIdentifier).toBe('ORCA-123')
    expect(store.getWorktreeMeta('wt-sibling')?.linkedTaskSourceContext).toBeNull()
    // Reject corrupt rows before unguarded consumers read them, including older builds after rollback.
    expect(store.getAllWorktreeMeta()).not.toHaveProperty('r1::/tmp/wt')
    expect(store.getAllWorktreeMeta()).not.toHaveProperty('r1::/tmp/scalar')
    expect(store.getWorktreeLineage('r1::/tmp/wt')).toBeUndefined()
    store.flush()
    const persisted = readDataFile() as PersistedState
    expect(persisted.worktreeMeta).not.toHaveProperty('r1::/tmp/wt')
    expect(persisted.worktreeMeta).not.toHaveProperty('r1::/tmp/scalar')
    expect(persisted.workspaceLineageByChildKey).not.toHaveProperty('worktree:r1::/tmp/wt')
  })

  it('persists exact folder workspace paths without a group folder on create, update and reload', async () => {
    const store = await createStore()
    const group = store.createProjectGroup({
      name: 'Platform',
      createdFrom: 'manual'
    })
    expect(group.parentPath).toBeNull()
    const workspace = store.createFolderWorkspace({
      projectGroupId: group.id,
      folderPath: '/workspace/platform '
    })

    expect(workspace.folderPath).toBe('/workspace/platform ')
    expect(
      store.updateFolderWorkspace(workspace.id, { folderPath: '/workspace/platform-next ' })
        ?.folderPath
    ).toBe('/workspace/platform-next ')

    store.flush()
    const restored = await createStore()
    expect(restored.getFolderWorkspace(workspace.id)?.folderPath).toBe('/workspace/platform-next ')
  })

  it('backfills folder-scope SSH provenance from grouped repos despite unrelated same-path SSH repos', async () => {
    writeDataFile({
      schemaVersion: 1,
      repos: [
        makeRepo({
          id: 'api-ssh-1',
          path: '/workspace/platform/api',
          projectGroupId: 'root',
          connectionId: 'ssh-1'
        }),
        makeRepo({
          id: 'api-ssh-2',
          path: '/workspace/platform/api',
          projectGroupId: 'other-root',
          connectionId: 'ssh-2'
        })
      ],
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
          createdFrom: 'folder-scan',
          tabOrder: 0,
          isCollapsed: false,
          color: null,
          createdAt: 1,
          updatedAt: 1
        },
        {
          id: 'other-root',
          name: 'Platform other',
          parentPath: '/workspace/platform',
          parentGroupId: null,
          createdFrom: 'folder-scan',
          tabOrder: 1,
          isCollapsed: false,
          color: null,
          createdAt: 1,
          updatedAt: 1
        }
      ],
      folderWorkspaces: [
        {
          id: 'fw-1',
          projectGroupId: 'root',
          name: 'Refund fix',
          folderPath: '/workspace/platform',
          comment: '',
          isArchived: false,
          isUnread: false,
          isPinned: false,
          sortOrder: 1,
          lastActivityAt: 1,
          createdAt: 1,
          updatedAt: 1
        }
      ]
    })

    const store = await createStore()

    expect(store.getProjectGroups().find((group) => group.id === 'root')).toMatchObject({
      connectionId: 'ssh-1'
    })
    expect(store.getFolderWorkspaces()[0]).toMatchObject({ id: 'fw-1', connectionId: 'ssh-1' })
  })

  it('removes folder workspace metadata and its scoped session state only', async () => {
    const store = await createStore()
    const group = store.createProjectGroup({
      name: 'Platform',
      parentPath: '/workspace/platform',
      createdFrom: 'folder-scan'
    })
    store.addRepo(
      makeRepo({ id: 'api', path: '/workspace/platform/api', projectGroupId: group.id })
    )
    const workspace = store.createFolderWorkspace({ projectGroupId: group.id, name: 'Refund fix' })
    const key = folderWorkspaceKey(workspace.id)
    const tab = makeTerminalTab({ id: 'folder-tab', worktreeId: key })
    store.setWorkspaceSession({
      ...getDefaultWorkspaceSession(),
      activeWorkspaceKey: key,
      activeWorktreeId: key,
      activeTabId: tab.id,
      tabsByWorktree: { [key]: [tab], 'repo::/wt': [makeTerminalTab({ id: 'repo-tab' })] },
      terminalLayoutsByTabId: {
        [tab.id]: { root: null, activeLeafId: null, expandedLeafId: null },
        'repo-tab': { root: null, activeLeafId: null, expandedLeafId: null }
      },
      browserTabsByWorktree: {
        [key]: [
          {
            id: 'browser-workspace',
            worktreeId: key,
            url: 'about:blank',
            title: 'Blank',
            loading: false,
            faviconUrl: null,
            canGoBack: false,
            canGoForward: false,
            loadError: null,
            createdAt: 1
          }
        ]
      },
      browserPagesByWorkspace: {
        'browser-workspace': [
          {
            id: 'page-1',
            workspaceId: 'browser-workspace',
            worktreeId: key,
            url: 'about:blank',
            title: 'Blank',
            loading: false,
            faviconUrl: null,
            canGoBack: false,
            canGoForward: false,
            loadError: null,
            createdAt: 1
          }
        ]
      },
      activeTabIdByWorktree: { [key]: tab.id },
      lastVisitedAtByWorktreeId: { [key]: 10 }
    })

    expect(store.removeFolderWorkspace(workspace.id)).toBe(true)

    const session = store.getWorkspaceSession()
    expect(store.getFolderWorkspaces()).toEqual([])
    expect(store.getProjectGroups()).toHaveLength(1)
    expect(store.getRepo('api')?.projectGroupId).toBe(group.id)
    expect(session.activeWorkspaceKey).toBeNull()
    expect(session.activeWorktreeId).toBeNull()
    expect(session.activeTabId).toBeNull()
    expect(session.tabsByWorktree[key]).toBeUndefined()
    expect(session.tabsByWorktree['repo::/wt']).toHaveLength(1)
    expect(session.terminalLayoutsByTabId['folder-tab']).toBeUndefined()
    expect(session.terminalLayoutsByTabId['repo-tab']).toBeDefined()
    expect(session.browserPagesByWorkspace?.['browser-workspace']).toBeUndefined()
  })

  it('removes an ssh folder workspace from the partition that owns it', async () => {
    const store = await createStore()
    const group = store.createProjectGroup({
      name: 'Remote',
      parentPath: '/remote/platform',
      createdFrom: 'folder-scan',
      connectionId: 'target-1'
    })
    const workspace = store.createFolderWorkspace({ projectGroupId: group.id, name: 'Remote fix' })
    const key = folderWorkspaceKey(workspace.id)
    store.setWorkspaceSession(
      {
        ...getDefaultWorkspaceSession(),
        tabsByWorktree: { [key]: [makeTerminalTab({ id: 'remote-folder-tab', worktreeId: key })] }
      },
      'ssh:target-1'
    )

    expect(store.removeFolderWorkspace(workspace.id)).toBe(true)

    // Persisted host partitions seed startup workspaces; removed rows must not reappear next launch.
    expect(store.getWorkspaceSession('ssh:target-1').tabsByWorktree[key]).toBeUndefined()
  })
})
