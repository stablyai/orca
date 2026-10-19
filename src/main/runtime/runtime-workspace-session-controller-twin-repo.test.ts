import { describe, expect, it, vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import type { ExecutionHostId } from '../../shared/execution-host'
import {
  LOCAL_ROW,
  RUNTIME_ROW,
  SSH_ROW,
  TWIN_REPO_HOST_CASES,
  TWIN_WORKTREE_ID,
  twinPartitionSessions,
  type TwinCatalogRow,
  type TwinRepoRow
} from '../../shared/twin-repo-host-routing.test-fixture'
import { RuntimeWorkspaceSessionController } from './runtime-workspace-session-controller'

const layoutOwner = vi.hoisted(() => ({ isMain: true }))
vi.mock('../../shared/layout-owner-switch', () => ({
  get ORCA_LAYOUT_OWNER_IS_MAIN() {
    return layoutOwner.isMain
  }
}))

type Setup = {
  repos: TwinRepoRow[]
  catalog?: TwinCatalogRow[] | null
  saved?: ExecutionHostId[]
  staleOn?: ExecutionHostId[]
}

function controllerFor({ repos, catalog = null, saved = [], staleOn = [] }: Setup) {
  const sessions = twinPartitionSessions(saved, staleOn)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the controller reads only repos, folder workspaces and workspace sessions.
  const store = {
    getRepos: () => repos,
    getRepo: (id: string) => repos.find((row) => row.id === id),
    getFolderWorkspaces: () => [],
    getWorkspaceSessionHostIds: () => [...sessions.keys()],
    getWorkspaceSession: (hostId: ExecutionHostId) =>
      sessions.get(hostId) ?? getDefaultWorkspaceSession()
  } as never
  const controller = new RuntimeWorkspaceSessionController({
    getStore: () => store,
    resolveFolderConnectionId: () => null,
    hasRuntimeOwnedPtyCandidate: () => false,
    getCachedWorktrees: () => catalog
  })
  return { controller, sessions }
}

// The window's save routing is checked against the same table in workspace-session-twin-repo-host.test.ts.
describe('routing a repo id registered on two hosts, in a layout-owner build', () => {
  it.each(TWIN_REPO_HOST_CASES)('$name', ({ repos, catalog, saved, staleOn, expected }) => {
    layoutOwner.isMain = true
    const { controller } = controllerFor({ repos, catalog, saved, staleOn })
    expect(controller.tryGetHostId(TWIN_WORKTREE_ID)).toBe(expected)
  })

  it.each<[string, TwinRepoRow, ExecutionHostId]>([
    ['local', LOCAL_ROW, 'local'],
    ['SSH', SSH_ROW, 'ssh:box'],
    ['runtime', RUNTIME_ROW, 'runtime:env-1']
  ])('leaves a %s-only repo on its own host', (_label, row, expected) => {
    layoutOwner.isMain = true
    expect(controllerFor({ repos: [row] }).controller.tryGetHostId(TWIN_WORKTREE_ID)).toBe(expected)
  })

  it('hydrates a twin worktree from the partition the router picks, not the last repo row', () => {
    layoutOwner.isMain = true
    const { controller, sessions } = controllerFor({
      repos: [RUNTIME_ROW, LOCAL_ROW],
      saved: ['runtime:env-1']
    })
    expect(controller.getHydrationTargets(true).get(TWIN_WORKTREE_ID)).toBe(
      sessions.get('runtime:env-1')
    )
  })
})

describe('routing twins with the layout-owner switch off', () => {
  it.each<[string, TwinRepoRow[], ExecutionHostId]>([
    ['local and SSH twins', [SSH_ROW, LOCAL_ROW], 'ssh:box'],
    ['local and runtime twins', [RUNTIME_ROW, LOCAL_ROW], 'runtime:env-1'],
    ['SSH and runtime twins', [RUNTIME_ROW, SSH_ROW], 'runtime:env-1']
  ])('keeps the first catalog row for %s', (_label, repos, expected) => {
    layoutOwner.isMain = false
    expect(controllerFor({ repos }).controller.tryGetHostId(TWIN_WORKTREE_ID)).toBe(expected)
  })

  it('keeps hydrating from the last repo row', () => {
    layoutOwner.isMain = false
    const { controller } = controllerFor({
      repos: [RUNTIME_ROW, LOCAL_ROW],
      saved: ['runtime:env-1']
    })
    expect(controller.getHydrationTargets(true).has(TWIN_WORKTREE_ID)).toBe(false)
  })
})
