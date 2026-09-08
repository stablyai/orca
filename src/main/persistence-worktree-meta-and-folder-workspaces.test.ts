import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { rmSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { PersistedState } from '../shared/persisted-state-types'
import { getDefaultWorkspaceSession } from '../shared/constants'
import { folderWorkspaceKey } from '../shared/workspace-scope'
import {
  testState,
  createStore,
  writeDataFile,
  readDataFile,
  makeRepo,
  makeTerminalTab
} from './persistence-test-harness'

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
  // ── 8. setWorktreeMeta and getWorktreeMeta ─────────────────────────

  it('setWorktreeMeta creates meta with defaults for missing fields', async () => {
    const store = await createStore()
    const meta = store.setWorktreeMeta('wt1', { displayName: 'my-wt' })

    expect(meta.displayName).toBe('my-wt')
    expect(meta.comment).toBe('')
    expect(meta.linkedIssue).toBeNull()
    expect(meta.isArchived).toBe(false)
    expect(typeof meta.sortOrder).toBe('number')
  })

  it('setWorktreeMeta merges with existing meta', async () => {
    const store = await createStore()
    store.setWorktreeMeta('wt1', { displayName: 'first', comment: 'hello' })
    const updated = store.setWorktreeMeta('wt1', { comment: 'updated' })

    expect(updated.displayName).toBe('first')
    expect(updated.comment).toBe('updated')
  })

  it('persists paired Jira linked-item metadata and drops mismatched source context', async () => {
    const store = await createStore()
    const linkedWorkItem = {
      provider: 'jira' as const,
      type: 'issue' as const,
      number: 0,
      title: 'ORCA-123 Link Jira',
      url: 'https://company.atlassian.net/browse/ORCA-123',
      jiraIdentifier: 'ORCA-123'
    }
    const linkedTaskSourceContext = {
      kind: 'task-source' as const,
      provider: 'jira' as const,
      projectId: 'project-1',
      hostId: 'runtime:env-1' as const,
      providerIdentity: {
        provider: 'jira' as const,
        siteId: 'site-1',
        siteUrl: 'https://company.atlassian.net',
        projectKey: 'ORCA'
      },
      accountLabel: 'ada@example.com'
    }

    store.setWorktreeMeta('wt-jira', { linkedWorkItem, linkedTaskSourceContext })
    store.flush()
    const restored = await createStore()

    expect(restored.getWorktreeMeta('wt-jira')).toMatchObject({
      linkedWorkItem,
      linkedTaskSourceContext
    })
    expect(
      restored.setWorktreeMeta('wt-jira', {
        linkedTaskSourceContext: { ...linkedTaskSourceContext, provider: 'linear' }
      }).linkedTaskSourceContext
    ).toBeNull()
    expect(
      restored.setWorktreeMeta('wt-jira', {
        linkedTaskSourceContext: {
          ...linkedTaskSourceContext,
          providerIdentity: {
            ...linkedTaskSourceContext.providerIdentity,
            projectKey: 'OTHER'
          }
        }
      }).linkedTaskSourceContext
    ).toBeNull()
  })

  it('discards malformed persisted task-source metadata without aborting store load', async () => {
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {
        'wt-malformed': {
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

    expect(store.getWorktreeMeta('wt-malformed')?.linkedWorkItem?.jiraIdentifier).toBe('ORCA-123')
    expect(store.getWorktreeMeta('wt-malformed')?.linkedTaskSourceContext).toBeNull()
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
    // Corrupt entries must not survive: gcStaleWorktreeMeta keeps timestamp-less keys, and downstream
    // consumers deref worktreeMeta values unguarded (also keeps a rollback to an older build loadable).
    expect(store.getAllWorktreeMeta()).not.toHaveProperty('r1::/tmp/wt')
    expect(store.getAllWorktreeMeta()).not.toHaveProperty('r1::/tmp/scalar')
    expect(store.getWorktreeLineage('r1::/tmp/wt')).toBeUndefined()
    store.flush()
    const persisted = readDataFile() as PersistedState
    expect(persisted.worktreeMeta).not.toHaveProperty('r1::/tmp/wt')
    expect(persisted.worktreeMeta).not.toHaveProperty('r1::/tmp/scalar')
    expect(persisted.workspaceLineageByChildKey).not.toHaveProperty('worktree:r1::/tmp/wt')
  })

  it('creates and updates folder workspaces from folder-backed project groups', async () => {
    const store = await createStore()
    const group = store.createProjectGroup({
      name: 'Platform',
      parentPath: '/workspace/platform',
      createdFrom: 'folder-scan'
    })
    const linkedTask = {
      provider: 'linear' as const,
      type: 'issue' as const,
      number: 0,
      title: 'Refund fix',
      url: 'https://linear.app/acme/issue/ENG-123',
      linearIdentifier: 'ENG-123'
    }

    const workspace = store.createFolderWorkspace({
      projectGroupId: group.id,
      name: 'Refund fix',
      linkedTask
    })
    const updated = store.updateFolderWorkspace(workspace.id, {
      comment: 'Coordinate api and web',
      isPinned: true,
      lastActivityAt: 123,
      diffComments: [
        {
          id: 'note-1',
          worktreeId: folderWorkspaceKey(workspace.id),
          filePath: 'README.md',
          source: 'markdown',
          lineNumber: 1,
          body: 'Review this paragraph',
          createdAt: 100,
          side: 'modified'
        }
      ]
    })

    expect(workspace.folderPath).toBe('/workspace/platform')
    expect(updated).toMatchObject({
      id: workspace.id,
      projectGroupId: group.id,
      name: 'Refund fix',
      folderPath: '/workspace/platform',
      linkedTask,
      comment: 'Coordinate api and web',
      isPinned: true,
      lastActivityAt: 123,
      diffComments: [expect.objectContaining({ id: 'note-1', body: 'Review this paragraph' })]
    })
    expect(store.getFolderWorkspaces()).toHaveLength(1)
    store.flush()

    const restored = await createStore()
    expect(restored.getFolderWorkspace(workspace.id)?.diffComments).toEqual([
      expect.objectContaining({ id: 'note-1', body: 'Review this paragraph' })
    ])
  })

  it('persists the exact folder workspace path provided on create and update', async () => {
    const store = await createStore()
    const group = store.createProjectGroup({
      name: 'Platform',
      parentPath: '/workspace/platform',
      createdFrom: 'folder-scan'
    })
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

  it('round-trips Jira item and source context for repo-less folder workspaces', async () => {
    const store = await createStore()
    const group = store.createProjectGroup({
      name: 'Platform',
      parentPath: '/workspace/platform',
      createdFrom: 'folder-scan'
    })
    const linkedTask = {
      provider: 'jira' as const,
      type: 'issue' as const,
      number: 0,
      title: 'ORCA-123 Link Jira',
      url: 'https://company.atlassian.net/browse/ORCA-123',
      jiraIdentifier: 'ORCA-123'
    }
    const linkedTaskSourceContext = {
      kind: 'task-source' as const,
      provider: 'jira' as const,
      projectId: group.id,
      hostId: 'runtime:folder-env' as const,
      repoId: null,
      providerIdentity: {
        provider: 'jira' as const,
        siteId: 'site-1',
        siteUrl: 'https://company.atlassian.net',
        projectKey: 'ORCA'
      },
      accountLabel: 'ada@example.com'
    }

    const workspace = store.createFolderWorkspace({
      projectGroupId: group.id,
      linkedTask,
      linkedTaskSourceContext
    })
    store.flush()
    const restored = await createStore()

    expect(restored.getFolderWorkspaces()).toContainEqual(
      expect.objectContaining({
        id: workspace.id,
        linkedTask,
        linkedTaskSourceContext: expect.objectContaining(linkedTaskSourceContext)
      })
    )
  })

  it('rejects folder workspace creation for non-folder-backed project groups', async () => {
    const store = await createStore()
    const group = store.createProjectGroup({ name: 'Manual', createdFrom: 'manual' })

    expect(() => store.createFolderWorkspace({ projectGroupId: group.id })).toThrow(
      'Folder-backed project group not found.'
    )
  })

  it('trims the group parentPath fallback and rejects a blank one', async () => {
    // parentPath is persisted verbatim, so a padded scan result would otherwise become a folderPath
    // that no path comparison matches.
    const store = await createStore()
    const padded = store.createProjectGroup({
      name: 'Platform',
      parentPath: '  /workspace/platform  ',
      createdFrom: 'folder-scan'
    })
    const blank = store.createProjectGroup({
      name: 'Blank',
      parentPath: '   ',
      createdFrom: 'folder-scan'
    })

    expect(store.createFolderWorkspace({ projectGroupId: padded.id }).folderPath).toBe(
      '/workspace/platform'
    )
    expect(() => store.createFolderWorkspace({ projectGroupId: blank.id })).toThrow(
      'Folder-backed project group not found.'
    )
  })

  it('normalizes persisted folder workspaces and drops orphaned records', async () => {
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
          createdFrom: 'folder-scan',
          tabOrder: 0,
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
          name: '  ',
          folderPath: '',
          comment: 42,
          isArchived: true,
          isUnread: true,
          isPinned: false,
          sortOrder: 10,
          lastActivityAt: 5,
          createdAt: 2,
          updatedAt: 3
        },
        {
          id: 'orphan',
          projectGroupId: 'missing',
          name: 'Orphan',
          folderPath: '/missing'
        }
      ]
    })

    const store = await createStore()

    expect(store.getFolderWorkspaces()).toEqual([
      expect.objectContaining({
        id: 'fw-1',
        projectGroupId: 'root',
        name: 'Untitled workspace',
        folderPath: '/workspace/platform',
        comment: '',
        isArchived: true,
        isUnread: true
      })
    ])
  })

  it('backfills folder-scope SSH provenance from unambiguous child repos on load', async () => {
    writeDataFile({
      schemaVersion: 1,
      repos: [
        makeRepo({
          id: 'api',
          path: '/workspace/platform/api',
          projectGroupId: 'root',
          connectionId: 'ssh-1'
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

    expect(store.getProjectGroups()[0]).toMatchObject({ id: 'root', connectionId: 'ssh-1' })
    expect(store.getFolderWorkspaces()[0]).toMatchObject({ id: 'fw-1', connectionId: 'ssh-1' })
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
})
