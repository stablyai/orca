import { describe, expect, it, vi, beforeEach } from 'vitest'
import { SshConnectionStore } from './ssh-connection-store'
import { createMockStore } from './ssh-connection-store-test-fixture'
import type { SshTarget } from '../../shared/ssh-types'

const { loadUserSshConfigMock, sshConfigHostsToTargetsMock } = vi.hoisted(() => ({
  loadUserSshConfigMock: vi.fn(),
  sshConfigHostsToTargetsMock: vi.fn()
}))

vi.mock('./ssh-config-parser', () => ({
  loadUserSshConfig: loadUserSshConfigMock,
  sshConfigHostsToTargets: sshConfigHostsToTargetsMock
}))

describe('SshConnectionStore', () => {
  let mockStore: ReturnType<typeof createMockStore>
  let sshStore: SshConnectionStore

  beforeEach(() => {
    mockStore = createMockStore()
    sshStore = new SshConnectionStore(mockStore as never)
    loadUserSshConfigMock.mockReset()
    sshConfigHostsToTargetsMock.mockReset()
  })

  describe('claimOrcadRuntimeTarget', () => {
    function addTarget(overrides: Partial<SshTarget> = {}): SshTarget {
      const target: SshTarget = {
        id: 'ssh-1',
        label: 'Managed server',
        host: 'example.com',
        port: 22,
        username: 'deploy',
        generation: 7,
        ...overrides
      }
      mockStore.addSshTarget(target)
      return target
    }

    it('claims and hides an unused target', () => {
      addTarget()

      expect(sshStore.claimOrcadRuntimeTarget('ssh-1', 'environment-1')).toMatchObject({
        generation: 7,
        owner: { type: 'on-demand-runtime', runtimeId: 'managed-orcad:environment-1' }
      })
      expect(sshStore.listTargets()).toEqual([])
    })

    it('hides provisioning intent before ownership is claimed and retires it on explicit release', () => {
      addTarget({ orcadProvisioning: { requestId: 'request-1', name: 'Managed server' } })
      expect(sshStore.listTargets()).toEqual([])
      expect(sshStore.assertOrcadRuntimeTargetClaimable('ssh-1', 'environment-1').id).toBe('ssh-1')
      sshStore.claimOrcadRuntimeTarget('ssh-1', 'environment-1')
      expect(sshStore.releaseOrcadRuntimeTarget('ssh-1', 'wrong-environment')).toBeNull()
      expect(sshStore.getTarget('ssh-1')?.orcadProvisioning).toBeDefined()
      sshStore.releaseOrcadRuntimeTarget('ssh-1', 'environment-1')
      expect(sshStore.getTarget('ssh-1')?.orcadProvisioning).toBeUndefined()
      expect(sshStore.listTargets()).toHaveLength(1)
    })

    it('reports exact drainable, live-or-unverifiable, and client-owned blockers', () => {
      addTarget({
        portForwards: [
          { localPort: 9000, remoteHost: '127.0.0.1', remotePort: 6768, label: 'Preview' }
        ]
      })
      mockStore.repos.push(
        {
          id: 'repo-1',
          path: '/srv/repo',
          displayName: 'Remote repo',
          badgeColor: '#3b82f6',
          addedAt: 1,
          kind: 'git',
          connectionId: 'ssh-1'
        },
        {
          id: 'repo-other',
          path: '/srv/other',
          displayName: 'Other repo',
          badgeColor: '#3b82f6',
          addedAt: 1,
          kind: 'git',
          connectionId: 'ssh-other'
        }
      )
      mockStore.folderWorkspaces.push({
        id: 'folder-1',
        projectGroupId: 'group-1',
        name: 'Remote folder',
        folderPath: '/srv/folder',
        connectionId: 'ssh-1',
        linkedTask: null,
        comment: '',
        isArchived: false,
        isUnread: false,
        isPinned: false,
        sortOrder: 0,
        lastActivityAt: 1,
        createdAt: 1,
        updatedAt: 1
      })
      mockStore.leases.push(
        {
          state: 'detached',
          ptyId: 'pty-live-or-unverifiable',
          worktreeId: 'repo-1::/srv/repo',
          tabId: 'tab-1',
          leafId: 'leaf-1',
          updatedAt: 42
        },
        { state: 'terminated', ptyId: 'pty-exited', updatedAt: 43 }
      )

      expect(sshStore.preflightOrcadRuntimeTarget('ssh-1')).toEqual({
        targetId: 'ssh-1',
        targetLabel: 'Managed server',
        claimable: false,
        blockers: [
          {
            code: 'orcad_migration_direct_ssh_repositories',
            category: 'drainable-static-state',
            repositories: [
              {
                id: 'repo-1',
                path: '/srv/repo',
                displayName: 'Remote repo',
                kind: 'git'
              }
            ]
          },
          {
            code: 'orcad_migration_direct_ssh_folder_workspaces',
            category: 'drainable-static-state',
            folderWorkspaces: [{ id: 'folder-1', name: 'Remote folder', folderPath: '/srv/folder' }]
          },
          {
            code: 'orcad_migration_direct_ssh_terminal_leases',
            category: 'live-or-unverifiable',
            terminalLeases: [
              {
                ptyId: 'pty-live-or-unverifiable',
                worktreeId: 'repo-1::/srv/repo',
                tabId: 'tab-1',
                leafId: 'leaf-1',
                state: 'detached',
                updatedAt: 42
              }
            ]
          },
          {
            code: 'orcad_migration_saved_port_forwards',
            category: 'client-owned-state',
            portForwards: [
              { localPort: 9000, remoteHost: '127.0.0.1', remotePort: 6768, label: 'Preview' }
            ]
          }
        ]
      })
    })

    it('allows static catalog rows to proceed through the migration flow', () => {
      addTarget()
      mockStore.repos.push({
        id: 'repo-1',
        path: '/srv/repo',
        displayName: 'Remote repo',
        badgeColor: '#3b82f6',
        addedAt: 1,
        kind: 'git',
        connectionId: 'ssh-1'
      })

      expect(sshStore.preflightOrcadRuntimeTarget('ssh-1')).toMatchObject({
        claimable: true,
        blockers: [
          {
            code: 'orcad_migration_direct_ssh_repositories',
            category: 'drainable-static-state'
          }
        ]
      })
    })

    it('blocks hidden dependent state reported by the full target census', () => {
      addTarget()
      const census = mockStore.inspectOrcadMigrationSourceDependencies()
      census.totalCount = 2
      census.counts.automation = 2
      mockStore.inspectOrcadMigrationSourceDependencies.mockReturnValue(census)

      expect(sshStore.preflightOrcadRuntimeTarget('ssh-1')).toMatchObject({
        claimable: false,
        blockers: [
          {
            code: 'orcad_migration_dependent_state',
            category: 'client-owned-state',
            dependencies: [{ kind: 'automation', count: 2 }]
          }
        ]
      })
    })

    it('reports a stable missing-target blocker without reading dependent state', () => {
      expect(sshStore.preflightOrcadRuntimeTarget('missing')).toEqual({
        targetId: 'missing',
        targetLabel: null,
        claimable: false,
        blockers: [{ code: 'orcad_migration_target_not_found', category: 'registration' }]
      })
      expect(mockStore.getRepos).not.toHaveBeenCalled()
      expect(mockStore.getFolderWorkspaces).not.toHaveBeenCalled()
      expect(mockStore.getSshRemotePtyLeases).not.toHaveBeenCalled()
    })

    it('allocates a generation for a legacy target', () => {
      addTarget({ generation: undefined })

      expect(sshStore.claimOrcadRuntimeTarget('ssh-1', 'environment-1').generation).toBe(1)
      expect(mockStore.allocateSshTargetGeneration).toHaveBeenCalledOnce()
    })

    it('allocates a generation behind an existing durable migration fence', () => {
      addTarget({
        generation: undefined,
        owner: { type: 'orcad-runtime', environmentId: 'environment-1' }
      })

      expect(sshStore.ensureOrcadRuntimeTargetGeneration('ssh-1', 'environment-1').generation).toBe(
        1
      )
      expect(mockStore.allocateSshTargetGeneration).toHaveBeenCalledOnce()
    })

    it('is idempotent for the same environment', () => {
      const target = addTarget({
        owner: { type: 'orcad-runtime', environmentId: 'environment-1' }
      })
      mockStore.leases.push({ state: 'detached' })

      expect(sshStore.preflightOrcadRuntimeTarget('ssh-1', 'environment-1')).toEqual({
        targetId: 'ssh-1',
        targetLabel: 'Managed server',
        claimable: true,
        blockers: []
      })
      expect(sshStore.claimOrcadRuntimeTarget('ssh-1', 'environment-1')).toBe(target)
      expect(mockStore.updateSshTarget).not.toHaveBeenCalled()
    })

    it.each([
      {
        name: 'another managed server',
        owner: { type: 'orcad-runtime' as const, environmentId: 'environment-2' }
      },
      {
        name: 'an on-demand runtime',
        owner: { type: 'on-demand-runtime' as const, runtimeId: 'runtime-1' }
      }
    ])('rejects a target owned by $name', ({ owner }) => {
      addTarget({ owner })

      expect(() => sshStore.claimOrcadRuntimeTarget('ssh-1', 'environment-1')).toThrow(
        'already owned'
      )
    })

    it.each([
      ['repository', 'repos'],
      ['folder workspace', 'folderWorkspaces']
    ] as const)('rejects a target used by a %s', (_name, collection) => {
      addTarget()
      if (collection === 'repos') {
        mockStore.repos.push({
          id: 'repo-1',
          path: '/srv/repo',
          displayName: 'Remote repo',
          badgeColor: '#3b82f6',
          addedAt: 1,
          kind: 'git',
          connectionId: 'ssh-1'
        })
      } else {
        mockStore.folderWorkspaces.push({
          id: 'folder-1',
          projectGroupId: 'group-1',
          name: 'Remote folder',
          folderPath: '/srv/folder',
          connectionId: 'ssh-1',
          linkedTask: null,
          comment: '',
          isArchived: false,
          isUnread: false,
          isPinned: false,
          sortOrder: 0,
          lastActivityAt: 1,
          createdAt: 1,
          updatedAt: 1
        })
      }

      expect(() => sshStore.claimOrcadRuntimeTarget('ssh-1', 'environment-1')).toThrow(
        'owns repositories or folder workspaces'
      )
    })

    it.each(['attached', 'detached'] as const)('rejects a %s terminal lease', (state) => {
      addTarget()
      mockStore.leases.push({ state })

      expect(() => sshStore.claimOrcadRuntimeTarget('ssh-1', 'environment-1')).toThrow(
        'still owns terminal sessions'
      )
    })

    it.each(['terminated', 'expired'] as const)('accepts a %s terminal lease', (state) => {
      addTarget()
      mockStore.leases.push({ state })

      expect(sshStore.claimOrcadRuntimeTarget('ssh-1', 'environment-1').owner).toEqual({
        type: 'on-demand-runtime',
        runtimeId: 'managed-orcad:environment-1'
      })
    })

    it('rejects saved port forwards', () => {
      addTarget({ portForwards: [{ localPort: 9000, remoteHost: '127.0.0.1', remotePort: 6768 }] })

      expect(() => sshStore.claimOrcadRuntimeTarget('ssh-1', 'environment-1')).toThrow(
        'saved port forwards'
      )
    })
  })
})
