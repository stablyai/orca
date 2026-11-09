import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { projectHostSetupProjectionFromRepos } from '../../../../../shared/project-host-setup-projection'
import type { Repo } from '../../../../../shared/repo-types'
import type { OrcaRuntimeService } from '../../../orca-runtime'
import { partialRuntimeStore } from '../../../orca-runtime-tests/runtime-store-partial-fixture'
import { RuntimeProjectHostSetupController } from '../../../repositories/runtime-project-host-setup-controller'
import { RuntimeRepositoryRegistrationController } from '../../../repositories/runtime-repository-registration-controller'
import { RpcDispatcher } from '../../dispatcher'
import { PROJECT_RUNTIME_METHODS } from './project-runtime-rpc-methods'

vi.mock('../../../../repository-icons/repo-icon-autodetect', () => ({
  detectRepoIconAndUpstream: vi.fn().mockResolvedValue({})
}))
vi.mock('../../../../workspaces/creation/worktree-root-preparation', () => ({
  prepareLocalWorktreeRootForRepo: vi.fn().mockResolvedValue(undefined)
}))

// #15376: a client's runtime:<id> is its own name for this server, so the server must store its files as local.
it("stores a paired client's runtime host id for this server's folder as local", async () => {
  const folder = await realpath(await mkdtemp(join(tmpdir(), 'orca-caller-host-stamp-')))
  const repos: Repo[] = []
  const store = partialRuntimeStore({
    getRepos: () => repos,
    getRepo: (id) => repos.find((repo) => repo.id === id),
    addRepo: (repo) => repos.push(repo),
    updateRepo: ({ id }, updates) => {
      const repo = repos.find((entry) => entry.id === id)
      return repo ? Object.assign(repo, updates) : null
    },
    getProjects: () => [...projectHostSetupProjectionFromRepos(repos).projects],
    getProjectHostSetups: () => [...projectHostSetupProjectionFromRepos(repos).setups]
  })
  const invalidators = {
    invalidateResolvedWorktrees: () => {},
    invalidateWorktreeScan: () => {},
    notifyReposChanged: () => {}
  }
  const registrations = new RuntimeRepositoryRegistrationController({
    getStore: () => store,
    ...invalidators
  })
  const setups = new RuntimeProjectHostSetupController({
    getStore: () => store,
    listRepos: () => repos,
    addRepo: (path, kind, hostId) => registrations.add(path, kind, hostId),
    cloneRepo: () => Promise.reject(new Error('unused')),
    countLiveTerminalsForRepo: () => 0,
    ...invalidators
  })
  const dispatcher = new RpcDispatcher({
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: setupExistingFolder's handler reads only these members.
    runtime: {
      getRuntimeId: () => 'build-box',
      setupProjectExistingFolder: (args) => setups.setupExistingFolder(args)
    } as OrcaRuntimeService,
    methods: PROJECT_RUNTIME_METHODS
  })
  try {
    const response = await dispatcher.dispatch({
      id: 'req-1',
      authToken: 'tok',
      method: 'projectHostSetup.setupExistingFolder',
      params: {
        projectId: 'github:acme/notes',
        projectProviderIdentity: { provider: 'github', owner: 'acme', repo: 'notes' },
        hostId: 'runtime:mac-pairing-key',
        path: folder,
        kind: 'folder'
      }
    })

    expect(response).toMatchObject({ ok: true })
    expect(repos).toEqual([expect.objectContaining({ path: folder, executionHostId: 'local' })])
    expect(store.getProjectHostSetups?.()).toEqual([expect.objectContaining({ hostId: 'local' })])
  } finally {
    await rm(folder, { recursive: true, force: true })
  }
})
