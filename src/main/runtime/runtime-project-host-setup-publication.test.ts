// Runtime RPC setup edits used to change the store silently: open clients kept the old catalog
// and cached worktree scans kept answering for the old path or kind (#26562).
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RuntimeProjectHostSetupController } from './runtime-project-host-setup-controller'
import { registerWorktreeChangeInvalidator } from '../ipc/worktree-change-invalidators'
import { projectHostSetupProjectionFromRepos } from '../../shared/project-host-setup-projection'
import type { Repo } from '../../shared/repo-types'
import type { RuntimeStore } from './runtime-store-contract'

const repo: Repo = {
  id: 'repo-1',
  path: '/srv/app',
  displayName: 'app',
  badgeColor: 'blue',
  addedAt: 1,
  kind: 'git',
  sourceControlAi: {
    actionOverrides: {
      fixChecks: {
        agentId: 'claude',
        agentArgs: '',
        launchPreferences: {
          agentId: 'codex',
          permissionMode: 'ask',
          modelSelection: {
            base: 'inherit',
            model: { agentId: 'claude', value: null }
          }
        },
        argumentChoices: { syntaxAgent: 'claude', nodes: [{ at: 0, text: '--effort high' }] }
      }
    }
  }
}
const projection = projectHostSetupProjectionFromRepos([repo])
const project = projection.projects[0]
const setup = projection.setups[0]

let unregister: (() => void) | undefined
afterEach(() => unregister?.())

function makeController(): {
  controller: RuntimeProjectHostSetupController
  notifyReposChanged: ReturnType<typeof vi.fn>
  invalidateResolvedWorktrees: ReturnType<typeof vi.fn>
  retired: string[]
} {
  const store = {
    createProjectHostSetup: () => ({ project, setup }),
    updateProjectHostSetup: () => ({ project, setup, repo }),
    deleteProjectHostSetup: () => ({ project, setup, repo }),
    getProjectHostSetups: () => [setup]
  }
  const retired: string[] = []
  unregister = registerWorktreeChangeInvalidator((repoId) => retired.push(repoId))
  const notifyReposChanged = vi.fn()
  const invalidateResolvedWorktrees = vi.fn()
  const controller = new RuntimeProjectHostSetupController({
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the controller only calls the setup methods stubbed above.
    getStore: () => store as unknown as RuntimeStore,
    listRepos: () => [repo],
    addRepo: vi.fn(),
    cloneRepo: vi.fn(),
    invalidateResolvedWorktrees,
    invalidateWorktreeScan: vi.fn(),
    notifyReposChanged,
    countLiveTerminalsForRepo: () => 0
  })
  return { controller, notifyReposChanged, invalidateResolvedWorktrees, retired }
}

describe('RuntimeProjectHostSetupController publication', () => {
  it('publishes a created setup to open clients', () => {
    const { controller, notifyReposChanged } = makeController()
    const result = controller.createSetup({
      projectId: project.id,
      hostId: 'local',
      path: '/srv/app'
    })
    expect(result.setup.sourceControlAi).toEqual(repo.sourceControlAi)
    expect(controller.listSetups()).toEqual([setup])
    expect(notifyReposChanged).toHaveBeenCalledTimes(1)
  })

  it('publishes a rename without retiring cached worktree scans', async () => {
    const { controller, notifyReposChanged, invalidateResolvedWorktrees, retired } =
      makeController()
    const result = await controller.updateSetup({
      setupId: setup.id,
      updates: { displayName: 'renamed' }
    })
    expect(result.setup.sourceControlAi).toEqual(repo.sourceControlAi)
    expect(result.repo?.sourceControlAi).toEqual(repo.sourceControlAi)
    expect(notifyReposChanged).toHaveBeenCalledTimes(1)
    expect(invalidateResolvedWorktrees).toHaveBeenCalled()
    expect(retired).toEqual([])
  })

  it.each([{ kind: 'folder' as const }, { path: '/srv/moved' }])(
    'retires cached worktree scans when a setup changes %o',
    async (updates) => {
      const { controller, notifyReposChanged, retired } = makeController()
      await controller.updateSetup({ setupId: setup.id, updates })
      expect(retired).toEqual(['repo-1'])
      expect(notifyReposChanged).toHaveBeenCalledTimes(1)
    }
  )

  it('retires cached worktree scans and publishes a deleted setup', () => {
    const { controller, notifyReposChanged, retired } = makeController()
    controller.deleteSetup({ setupId: setup.id })
    expect(retired).toEqual(['repo-1'])
    expect(notifyReposChanged).toHaveBeenCalledTimes(1)
  })
})
