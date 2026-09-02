import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { writeFileSync, rmSync, mkdtempSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { PersistedState } from '../shared/persisted-state-types'
import type { WorkspaceSessionState } from '../shared/workspace-session-state-types'
import { getDefaultPersistedState, getDefaultWorkspaceSession } from '../shared/constants'
import { closeTerminalTabInWorkspaceSession } from '../shared/workspace-session-terminal-tab-close'
import {
  testState,
  createStore,
  writeDataFile,
  readDataFile,
  makeRepo,
  makeProject,
  makeProjectHostSetup
} from './persistence-test-harness'
import { TEST_LEAF_1 } from './persistence-session-fixtures'
import {
  getLocalWorktreeScanGeneration,
  isLocalWorktreeScanGenerationCurrent
} from './local-worktree-scan-generation'

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
  // ── 1. Defaults when no file exists ──────────────────────────────────

  it('returns empty repos when no data file exists', async () => {
    const store = await createStore()
    expect(store.getRepos()).toEqual([])
  }, 15_000)

  it('clone-reads and synchronously persists the main-owned Codex reset ledger', async () => {
    const store = await createStore()
    const ledger = {
      version: 1 as const,
      attempts: [
        {
          idempotencyKey: '11111111-1111-4111-8111-111111111111',
          expectedScope: {
            target: { runtime: 'host' as const, wslDistro: null },
            accountId: 'account-host',
            accountRevision: 42,
            offerRevision: 'v1:offer'
          },
          state: 'providerPending' as const
        }
      ]
    }

    store.replaceCodexResetCreditAttemptLedgerAndFlush(ledger)
    const firstRead = store.getCodexResetCreditAttemptLedger()
    firstRead.attempts.splice(0, 1)

    expect(store.getCodexResetCreditAttemptLedger()).toEqual(ledger)
    expect((readDataFile() as PersistedState).codexResetCreditAttemptLedger).toEqual(ledger)
  })

  it('rolls the in-memory Codex reset ledger back when its sync flush fails', async () => {
    const store = await createStore()
    const before = store.getCodexResetCreditAttemptLedger()
    vi.spyOn(store, 'flushOrThrow').mockImplementationOnce(() => {
      throw new Error('disk full')
    })

    expect(() =>
      store.replaceCodexResetCreditAttemptLedgerAndFlush({
        version: 1,
        attempts: [
          {
            idempotencyKey: '11111111-1111-4111-8111-111111111111',
            expectedScope: {
              target: { runtime: 'host', wslDistro: null },
              accountId: 'account-host',
              accountRevision: 42,
              offerRevision: 'v1:offer'
            },
            state: 'providerPending'
          }
        ]
      })
    ).toThrow('disk full')

    expect(store.getCodexResetCreditAttemptLedger()).toEqual(before)
  })

  it('preserves a corrupt Codex reset ledger as a fail-closed read error', async () => {
    writeDataFile({
      ...getDefaultPersistedState(testState.dir),
      codexResetCreditAttemptLedger: {
        version: 1,
        attempts: [{ state: 'providerPending' }]
      }
    })

    const store = await createStore()
    expect(() => store.getCodexResetCreditAttemptLedger()).toThrow(
      'Codex reset-credit attempt ledger is corrupt'
    )
  })

  it('does not restore a terminal tab after its durable close flush returns', async () => {
    const store = await createStore()
    // Registered on purpose: rows owned by an unregistered repo id are swept as orphans on load.
    store.addRepo(makeRepo({ id: 'repo-1', path: '/repo-1' }))
    const worktreeId = 'repo-1::/tmp/worktree-1'
    const tabId = 'terminal-1'
    const session: WorkspaceSessionState = {
      ...getDefaultWorkspaceSession(),
      activeWorktreeId: worktreeId,
      activeTabId: tabId,
      tabsByWorktree: {
        [worktreeId]: [
          {
            id: tabId,
            ptyId: 'pty-1',
            worktreeId,
            title: 'Terminal',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          }
        ]
      },
      terminalLayoutsByTabId: {
        [tabId]: {
          root: { type: 'leaf', leafId: TEST_LEAF_1 },
          activeLeafId: TEST_LEAF_1,
          expandedLeafId: null,
          ptyIdsByLeafId: { [TEST_LEAF_1]: 'pty-1' }
        }
      },
      activeTabIdByWorktree: { [worktreeId]: tabId },
      defaultTerminalTabsAppliedByWorktreeId: { [worktreeId]: true }
    }
    store.setWorkspaceSession(session)
    store.flushOrThrow()

    const closed = closeTerminalTabInWorkspaceSession(
      store.getWorkspaceSession(),
      worktreeId,
      tabId
    )
    store.setWorkspaceSession(closed.session)
    store.flushOrThrow()

    const reloaded = await createStore()
    expect(reloaded.getWorkspaceSession().tabsByWorktree[worktreeId]).toEqual([])
    expect(reloaded.getWorkspaceSession().terminalLayoutsByTabId[tabId]).toBeUndefined()
    expect(
      reloaded.getWorkspaceSession().defaultTerminalTabsAppliedByWorktreeId?.[worktreeId]
    ).toBe(true)
  })

  it('loads state from an explicit profile data file path', async () => {
    const profileDataDirectory = join(testState.dir, 'profiles', 'local-default')
    const profileDataFile = join(profileDataDirectory, 'orca-data.json')
    mkdirSync(profileDataDirectory, { recursive: true })
    writeDataFile({
      schemaVersion: 1,
      repos: [makeRepo({ id: 'legacy-root-repo', path: '/legacy' })]
    })
    writeFileSync(
      profileDataFile,
      JSON.stringify({
        schemaVersion: 1,
        repos: [makeRepo({ id: 'profile-repo', path: '/profile' })]
      }),
      'utf-8'
    )

    vi.resetModules()
    const { Store, initDataPath } = await import('./persistence')
    initDataPath()
    const store = new Store({ dataFile: profileDataFile })

    expect(store.getRepos().map((repo) => repo.id)).toEqual(['profile-repo'])
  }, 15_000)

  it('backfills project host setup compatibility records from legacy repos on load', async () => {
    writeDataFile({
      schemaVersion: 1,
      repos: [
        makeRepo({
          id: 'local-repo',
          path: '/Users/alice/orca',
          displayName: 'Orca',
          upstream: { owner: 'StablyAI', repo: 'Orca' }
        }),
        makeRepo({
          id: 'remote-repo',
          path: '/home/alice/orca',
          displayName: 'orca',
          connectionId: 'gpu-vm',
          upstream: { owner: 'stablyai', repo: 'orca' }
        })
      ]
    })

    const store = await createStore()

    expect(store.getProjects()).toEqual([
      expect.objectContaining({
        id: 'github:stablyai/orca',
        sourceRepoIds: ['local-repo', 'remote-repo']
      })
    ])
    expect(store.getProjectHostSetups()).toEqual([
      expect.objectContaining({
        id: 'local-repo',
        projectId: 'github:stablyai/orca',
        hostId: 'local',
        path: '/Users/alice/orca'
      }),
      expect.objectContaining({
        id: 'remote-repo',
        projectId: 'github:stablyai/orca',
        hostId: 'ssh:gpu-vm',
        path: '/home/alice/orca'
      })
    ])

    store.flush()
    const persisted = readDataFile() as PersistedState
    expect(persisted.projects).toEqual(store.getProjects())
    expect(persisted.projectHostSetups).toEqual(store.getProjectHostSetups())
  })

  it('preserves independent project host setup records on load', async () => {
    const independentProject = makeProject({
      id: 'cloud-project',
      displayName: 'Cloud Project'
    })
    const independentSetup = makeProjectHostSetup({
      id: 'cloud-project::gpu-vm',
      projectId: independentProject.id,
      hostId: 'runtime:gpu-vm',
      repoId: '',
      path: '/srv/cloud-project',
      displayName: 'GPU VM'
    })
    writeDataFile({
      ...getDefaultPersistedState(testState.dir),
      repos: [makeRepo({ id: 'r1', path: '/repo', displayName: 'Repo' })],
      projects: [independentProject],
      projectHostSetups: [independentSetup]
    })

    const store = await createStore()

    expect(store.getProjects().map((project) => project.id)).toEqual(['repo:r1', 'cloud-project'])
    expect(store.getProjectHostSetups().map((setup) => setup.id)).toEqual([
      'r1',
      'cloud-project::gpu-vm'
    ])
    store.flush()
    const persisted = readDataFile() as PersistedState
    expect(persisted.projectHostSetups).toContainEqual(independentSetup)
  })

  it('updates and persists a project Windows runtime preference', async () => {
    const project = makeProject({
      id: 'repo:r1',
      sourceRepoIds: ['r1'],
      localWindowsRuntimePreference: { kind: 'inherit-global' }
    })
    writeDataFile({
      ...getDefaultPersistedState(testState.dir),
      repos: [makeRepo({ id: 'r1' })],
      projects: [project],
      projectHostSetups: [
        makeProjectHostSetup({
          id: 'setup-1',
          projectId: project.id,
          repoId: ''
        })
      ]
    })
    const store = await createStore()
    const scanGeneration = getLocalWorktreeScanGeneration('r1')

    const updated = store.updateProject(project.id, {
      localWindowsRuntimePreference: { kind: 'wsl', distro: 'Ubuntu' }
    })

    expect(updated?.localWindowsRuntimePreference).toEqual({ kind: 'wsl', distro: 'Ubuntu' })
    expect(isLocalWorktreeScanGenerationCurrent('r1', scanGeneration)).toBe(false)
    store.flush()
    const reloaded = await createStore()
    expect(reloaded.getProjects()[0]?.localWindowsRuntimePreference).toEqual({
      kind: 'wsl',
      distro: 'Ubuntu'
    })
  })

  it('carries project state and independent setups across a repo remote identity change', async () => {
    const originProjectId = 'git:git.example.com/acme/app'
    writeDataFile({
      ...getDefaultPersistedState(testState.dir),
      repos: [
        makeRepo({
          id: 'r1',
          path: '/repo',
          displayName: 'App',
          gitRemoteIdentity: {
            canonicalKey: 'git.example.com/acme/app',
            remoteName: 'origin',
            remoteUrl: 'git@git.example.com:acme/app.git'
          }
        })
      ],
      projects: [
        makeProject({
          id: originProjectId,
          sourceRepoIds: ['r1'],
          localWindowsRuntimePreference: { kind: 'wsl', distro: 'Ubuntu' }
        })
      ],
      projectHostSetups: [
        makeProjectHostSetup({ id: 'r1', projectId: originProjectId, repoId: 'r1' }),
        makeProjectHostSetup({
          id: 'app::gpu-vm',
          projectId: originProjectId,
          hostId: 'runtime:gpu-vm',
          repoId: '',
          path: '/srv/app'
        })
      ]
    })
    const store = await createStore()

    // A re-probe that now prefers the `upstream` remote rewrites the derived project id.
    store.updateRepo('r1', {
      gitRemoteIdentity: {
        canonicalKey: 'git.example.com/acme/app-upstream',
        remoteName: 'upstream',
        remoteUrl: 'git@git.example.com:acme/app-upstream.git'
      }
    })

    const upstreamProjectId = 'git:git.example.com/acme/app-upstream'
    expect(store.getProjects().map((project) => project.id)).toEqual([upstreamProjectId])
    expect(store.getProjects()[0]?.localWindowsRuntimePreference).toEqual({
      kind: 'wsl',
      distro: 'Ubuntu'
    })
    expect(
      store.getProjectHostSetups().find((setup) => setup.id === 'app::gpu-vm')?.projectId
    ).toBe(upstreamProjectId)
  })

  it('picks one predecessor project when several prior rows overlap the same repos', async () => {
    const sharedIdentity = {
      canonicalKey: 'git.example.com/acme/shared',
      remoteName: 'origin',
      remoteUrl: 'git@git.example.com:acme/shared.git'
    }
    writeDataFile({
      ...getDefaultPersistedState(testState.dir),
      repos: [
        makeRepo({
          id: 'r1',
          path: '/left',
          displayName: 'Left',
          gitRemoteIdentity: sharedIdentity
        }),
        makeRepo({
          id: 'r2',
          path: '/right',
          displayName: 'Right',
          gitRemoteIdentity: sharedIdentity
        })
      ],
      projects: [
        makeProject({
          id: 'git:git.example.com/acme/left',
          sourceRepoIds: ['r1'],
          updatedAt: 200,
          localWindowsRuntimePreference: { kind: 'wsl', distro: 'Ubuntu' }
        }),
        makeProject({
          id: 'git:git.example.com/acme/right',
          sourceRepoIds: ['r2'],
          updatedAt: 100,
          localWindowsRuntimePreference: { kind: 'windows-host' }
        })
      ],
      projectHostSetups: [
        makeProjectHostSetup({
          id: 'r1',
          projectId: 'git:git.example.com/acme/left',
          repoId: 'r1'
        }),
        makeProjectHostSetup({
          id: 'r2',
          projectId: 'git:git.example.com/acme/right',
          repoId: 'r2'
        })
      ]
    })

    const store = await createStore()

    // Equal repo overlap resolves by newest updatedAt; the loser's preference is never merged in.
    expect(store.getProjects()).toEqual([
      expect.objectContaining({
        id: 'git:git.example.com/acme/shared',
        sourceRepoIds: ['r1', 'r2'],
        localWindowsRuntimePreference: { kind: 'wsl', distro: 'Ubuntu' }
      })
    ])
  })

  it('migrates legacy WSL agent settings into the global Windows runtime default', async () => {
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: {
        localAgentRuntime: 'wsl',
        localAgentWslDistro: 'Ubuntu'
      }
    })

    const store = await createStore()

    expect(store.getSettings().localWindowsRuntimeDefault).toEqual({
      kind: 'wsl',
      distro: 'Ubuntu'
    })
    store.flush()
    expect((readDataFile() as PersistedState).settings.localWindowsRuntimeDefault).toEqual({
      kind: 'wsl',
      distro: 'Ubuntu'
    })
  })

  it('migrates the legacy host account-runtime default to auto once', async () => {
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: {
        localAccountRuntime: 'host'
      }
    })

    const store = await createStore()

    expect(store.getSettings().localAccountRuntime).toBe('auto')
    expect(store.getSettings().localAccountRuntimeDefaultedToAutoForAllUsers).toBe(true)
    store.flush()
    const persisted = (readDataFile() as PersistedState).settings
    expect(persisted.localAccountRuntime).toBe('auto')
    expect(persisted.localAccountRuntimeDefaultedToAutoForAllUsers).toBe(true)
  })

  it('preserves an explicit WSL account-runtime pin through the migration', async () => {
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: {
        localAccountRuntime: 'wsl',
        localAccountWslDistro: 'Ubuntu'
      }
    })

    const store = await createStore()

    expect(store.getSettings().localAccountRuntime).toBe('wsl')
    expect(store.getSettings().localAccountRuntimeDefaultedToAutoForAllUsers).toBe(true)
  })

  it('does not re-flip an explicit host pin chosen after migration', async () => {
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: {
        localAccountRuntime: 'host',
        localAccountRuntimeDefaultedToAutoForAllUsers: true
      }
    })

    const store = await createStore()

    expect(store.getSettings().localAccountRuntime).toBe('host')
  })
})
