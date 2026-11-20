import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { projectSetupsWithWorkerExecutionTargets } from './worker-execution-target'
import {
  agentLaunchProjectRuntime,
  newWorktreeLaunchScope
} from '../../../terminal/launch/agent-launch-scope-runtime'
import { executionRuntimePlatform } from '../../../../../shared/agent-launch/startup/agent-launch-runtime'
import {
  partialRuntimeStore,
  storeProject,
  storeRepo
} from '../../../construction/test-context/runtime-store-partial-fixture'
import type { ProjectHostSetup } from '../../../../../shared/project/project-types'

vi.mock('../../../../wsl/discovery/distro-catalog', () => ({
  getCachedWslDistros: () => ['Ubuntu'],
  hasCachedWslDistros: () => true,
  getWslHome: () => null,
  getWslHomeAsync: async () => null
}))
vi.mock('../../../../wsl/discovery/wsl-availability', () => ({
  getCachedWslAvailability: () => true,
  hasCachedWslAvailability: () => true
}))

const originalPlatform = process.platform
beforeEach(() => Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' }))
afterEach(() =>
  Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
)

const setup: ProjectHostSetup = {
  id: 'setup',
  projectId: 'github:team/repo',
  hostId: 'local',
  repoId: 'repo',
  path: 'C:\\src\\repo',
  displayName: 'repo',
  kind: 'git',
  setupState: 'ready',
  setupMethod: 'legacy-repo',
  createdAt: 1,
  updatedAt: 1
}

it.each([
  { name: 'native drive', path: 'C:\\src\\repo', target: 'native', platform: 'win32' },
  {
    name: 'UNC repo',
    path: '\\\\wsl.localhost\\Ubuntu\\home\\repo',
    target: 'wsl',
    platform: 'linux'
  },
  {
    name: 'UNC repo overrides native preference',
    path: '\\\\wsl$\\Ubuntu\\home\\repo',
    preference: { kind: 'windows-host' as const },
    target: 'wsl',
    platform: 'linux'
  },
  {
    name: 'repo base',
    path: 'C:\\src\\repo',
    base: '\\\\wsl.localhost\\Ubuntu\\home\\worktrees',
    target: 'wsl',
    platform: 'linux'
  },
  {
    name: 'global base',
    path: 'C:\\src\\repo',
    globalBase: '\\\\wsl.localhost\\Ubuntu\\home\\worktrees',
    target: 'wsl',
    platform: 'linux'
  },
  {
    name: 'project WSL with native Git',
    path: 'C:\\src\\repo',
    preference: { kind: 'wsl' as const, distro: 'Ubuntu', git: 'windows-host' as const },
    target: 'wsl',
    platform: 'linux'
  },
  {
    name: 'global WSL',
    path: 'C:\\src\\repo',
    globalRuntime: { kind: 'wsl' as const, distro: 'Ubuntu' },
    target: 'wsl',
    platform: 'linux'
  },
  {
    name: 'native override of global WSL',
    path: 'C:\\src\\repo',
    preference: { kind: 'windows-host' as const },
    globalRuntime: { kind: 'wsl' as const, distro: 'Ubuntu' },
    target: 'native',
    platform: 'win32'
  },
  {
    name: 'missing distro',
    path: 'C:\\src\\repo',
    preference: { kind: 'wsl' as const, distro: 'Missing' },
    target: 'unknown',
    platform: 'linux'
  }
])('owner evidence follows launch authority: $name', (row) => {
  const repo = storeRepo({ id: 'repo', path: row.path, worktreeBasePath: row.base })
  const project = storeProject({
    id: 'github:team/repo',
    sourceRepoIds: ['repo'],
    localWindowsRuntimePreference: row.preference
  })
  const store = partialRuntimeStore({
    getProjects: () => [project],
    getRepo: () => repo,
    getSettings: () => ({
      workspaceDir: row.globalBase ?? 'C:\\worktrees',
      nestWorkspaces: false,
      localWindowsRuntimeDefault: row.globalRuntime
    })
  })
  const original = { ...setup }
  const result = projectSetupsWithWorkerExecutionTargets(store, [repo], [setup])
  expect(result[0].workerExecutionTarget).toEqual({ kind: row.target })
  expect(setup).toEqual(original)
  for (const agent of ['codex', 'opencode'] as const) {
    const scope = newWorktreeLaunchScope(repo, store.getSettings())
    const runtime = agentLaunchProjectRuntime(store, scope, agent)
    expect(executionRuntimePlatform(runtime, scope.path, 'win32')).toBe(row.platform)
  }
})

it('refuses original host twins and conflicting project associations', () => {
  const repo = storeRepo({ id: 'repo', path: 'C:\\src\\repo' })
  const project = storeProject({ id: 'github:team/repo', sourceRepoIds: ['repo'] })
  const store = partialRuntimeStore({ getProjects: () => [project] })
  expect(
    projectSetupsWithWorkerExecutionTargets(
      store,
      [repo, { ...repo, connectionId: 'ssh' }],
      [setup]
    )[0].workerExecutionTarget
  ).toEqual({ kind: 'unknown' })
  expect(
    projectSetupsWithWorkerExecutionTargets(store, [repo], [{ ...setup, hostId: 'ssh:box' }])[0]
      .workerExecutionTarget
  ).toEqual({ kind: 'unknown' })
  expect(
    projectSetupsWithWorkerExecutionTargets(
      partialRuntimeStore({
        getProjects: () => [project, storeProject({ id: 'repo', sourceRepoIds: [] })]
      }),
      [repo],
      [setup]
    )[0].workerExecutionTarget
  ).toEqual({ kind: 'unknown' })
  expect(
    projectSetupsWithWorkerExecutionTargets(
      store,
      [repo],
      [{ ...setup, projectId: 'different' }]
    )[0].workerExecutionTarget
  ).toEqual({ kind: 'unknown' })
})

it.each([
  { name: 'legacy absent repo host', repoHost: {}, setupHost: {}, target: 'native' },
  {
    name: 'legacy null repo host',
    repoHost: { executionHostId: null, connectionId: null },
    setupHost: {},
    target: 'native'
  },
  {
    name: 'explicit local agreement',
    repoHost: { executionHostId: 'local' as const },
    setupHost: { executionHostId: 'local' as const },
    target: 'native'
  },
  {
    name: 'local repo with SSH connection',
    repoHost: { executionHostId: 'local' as const, connectionId: 'box' },
    setupHost: {},
    target: 'unknown'
  },
  {
    name: 'whitespace SSH connection',
    repoHost: { connectionId: ' ' },
    setupHost: {},
    target: 'unknown'
  },
  ...(['ssh:', 'runtime:', 'ssh:%', 'runtime:%E0%A4%A'] as const).map((executionHostId) => ({
    name: `malformed repo host ${executionHostId}`,
    repoHost: { executionHostId },
    setupHost: {},
    target: 'unknown'
  })),
  {
    name: 'SSH repo with local setup',
    repoHost: { executionHostId: 'ssh:box' as const },
    setupHost: {},
    target: 'unknown'
  },
  {
    name: 'runtime repo with local setup',
    repoHost: { executionHostId: 'runtime:box' as const },
    setupHost: {},
    target: 'unknown'
  },
  {
    name: 'local setup with SSH connection',
    repoHost: {},
    setupHost: { connectionId: 'box' },
    target: 'unknown'
  },
  {
    name: 'local setup with SSH execution host',
    repoHost: {},
    setupHost: { executionHostId: 'ssh:box' as const },
    target: 'unknown'
  },
  {
    name: 'local setup with runtime execution host',
    repoHost: {},
    setupHost: { executionHostId: 'runtime:box' as const },
    target: 'unknown'
  }
])(
  'requires original hosts before producing evidence: $name',
  ({ repoHost, setupHost, target }) => {
    const repo = storeRepo({ id: 'repo', path: 'C:\\src\\repo', ...repoHost })
    const store = partialRuntimeStore({
      getProjects: () => [storeProject({ id: setup.projectId, sourceRepoIds: ['repo'] })]
    })
    expect(
      projectSetupsWithWorkerExecutionTargets(store, [repo], [{ ...setup, ...setupHost }])[0]
        .workerExecutionTarget
    ).toEqual({ kind: target })
  }
)

it('preserves native launch policy on non-Windows owners', () => {
  Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' })
  const repo = storeRepo({ id: 'repo', path: '/src/repo' })
  const store = partialRuntimeStore({
    getProjects: () => [
      storeProject({
        id: setup.projectId,
        sourceRepoIds: ['repo'],
        localWindowsRuntimePreference: { kind: 'wsl', distro: 'Ubuntu' }
      })
    ]
  })
  expect(
    projectSetupsWithWorkerExecutionTargets(store, [repo], [setup])[0].workerExecutionTarget
  ).toEqual({ kind: 'native' })
})
