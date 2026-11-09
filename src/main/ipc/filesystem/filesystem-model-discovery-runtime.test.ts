import type { DiscoveryIO } from './terminal-model-discovery.test-fixture'
import { expect, it, vi } from 'vitest'
const io = vi.hoisted<DiscoveryIO>(() => ({
  generateCommit: vi.fn(),
  generatePr: vi.fn(),
  handle: vi.fn(),
  env: vi.fn(),
  discover: vi.fn(),
  materialize: vi.fn(),
  distros: ['Ubuntu'],
  distrosKnown: false,
  rows: [],
  mutations: vi.fn(),
  userAct: vi.fn()
}))
vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/pr40175-terminal-discovery', isPackaged: false },
  ipcMain: { handle: io.handle, removeHandler: vi.fn() }
}))
vi.mock('node:fs/promises', async (original) => ({
  ...(await original<object>()),
  stat: async () => ({ isDirectory: () => true }),
  access: async () => {},
  realpath: async (path: string) => path,
  mkdir: io.mutations
}))
vi.mock('../../text-generation/commit-message-agent-environment', () => ({
  prepareLocalCommitMessageAgentEnv: io.env
}))
vi.mock('../../text-generation/commit-message-text-generation', async (original) => ({
  ...(await original<object>()),
  discoverCommitMessageModelsLocal: io.discover,
  generateCommitMessageFromContext: io.generateCommit,
  generatePullRequestFieldsFromContext: io.generatePr
}))
vi.mock('../../git/worktrees/catalog/worktree-scan-cache', async (original) => ({
  ...(await original<object>()),
  listWorktrees: async () => io.rows,
  listWorktreesSharedStrict: async () => io.rows
}))
vi.mock('../../git/worktrees/catalog/worktree-listing', async (original) => ({
  ...(await original<object>()),
  listWorktreesStrict: async () => io.rows
}))
vi.mock('../worktree-remote', async (original) => ({
  ...(await original<object>()),
  materializeWorktreePushTargetRemote: io.materialize
}))
vi.mock('../../wsl/discovery/wsl-availability', () => ({
  hasCachedWslAvailability: () => false
}))
vi.mock('../../wsl/discovery/distro-catalog', () => ({
  hasCachedWslDistros: () => io.distrosKnown,
  getCachedWslDistros: () => io.distros,
  listWslDistrosAsync: async () => io.distros
}))
vi.mock('../../wsl/filesystem/wsl-unc-access-gate', async (original) => ({
  ...(await original<object>()),
  blockedWslDistroForPath: async () => null,
  runAsWslUserAct: io.userAct
}))
vi.mock('../../git/source-control/staged-commit-context', () => ({
  getStagedCommitContext: async () => ({ patch: '+change', files: ['file.ts'] })
}))
vi.mock('../../text-generation/pull-request-context', () => ({
  getPullRequestDraftContext: async () => ({ patch: '+change', branch: 'fix' })
}))
vi.mock('../../source-control/pull-request-template', () => ({
  resolveHostedReviewBodyForGeneration: async () => ''
}))
vi.mock('../../source-control/pull-request-linked-issue', () => ({
  loadPullRequestLinkedIssue: async () => undefined
}))
import { createTerminalDiscoveryFixture } from './terminal-model-discovery.test-fixture'

const fixture = createTerminalDiscoveryFixture(io)

it.each([
  {
    name: 'native shell with leftover distro',
    shell: 'powershell.exe',
    distro: 'Ubuntu',
    model: 'native-model',
    guest: undefined
  },
  { name: 'default WSL shell', shell: 'wsl.exe', model: 'ubuntu-model', guest: 'Ubuntu' },
  {
    name: 'UNC authority',
    path: '\\\\wsl.localhost\\Ubuntu\\home\\me',
    distro: 'Debian',
    model: 'ubuntu-model',
    guest: 'Ubuntu'
  },
  {
    name: 'mixed project repo',
    repo: true,
    runtime: { kind: 'wsl', distro: 'Ubuntu', git: 'windows-host' },
    model: 'ubuntu-model',
    guest: 'Ubuntu'
  },
  {
    name: 'associated folder',
    runtime: { kind: 'wsl', distro: 'Ubuntu', git: 'windows-host' },
    model: 'ubuntu-model',
    guest: 'Ubuntu'
  },
  {
    name: 'forced host project',
    repo: true,
    shell: 'wsl.exe',
    runtime: { kind: 'windows-host' },
    model: 'native-model',
    guest: undefined
  },
  {
    name: 'Mac stale preference',
    platform: 'darwin',
    shell: 'wsl.exe',
    distro: 'Ubuntu',
    model: 'native-model',
    guest: undefined
  },
  {
    name: 'Linux stale preference',
    platform: 'linux',
    shell: 'wsl.exe',
    distro: 'Ubuntu',
    model: 'native-model',
    guest: undefined
  }
] as const)('$name uses the effective terminal runtime through IPC and RPC', async (input) => {
  const rig = fixture(input)
  for (const read of [rig.ipc, rig.rpc]) {
    expect(await read()).toMatchObject({ success: true, models: [{ id: input.model }] })
    expect(io.env.mock.calls.at(-1)?.[2]).toEqual(
      input.guest ? { runtime: 'wsl', wslDistro: input.guest } : { runtime: 'host' }
    )
    expect(io.discover.mock.calls.at(-1)?.[3]).toEqual(
      input.guest ? { cwd: rig.path, wslDistro: input.guest } : { cwd: rig.path }
    )
  }
  expect(io.userAct).not.toHaveBeenCalled()
})

it('does not probe natively when the WSL default is unresolved, and retries when the catalog fills', async () => {
  const rig = fixture({ shell: 'wsl.exe' })
  io.distros = []
  expect(await rig.ipc()).toEqual({
    success: false,
    error: 'terminal_execution_context_unresolved'
  })
  expect(io.env).not.toHaveBeenCalled()
  expect(io.discover).not.toHaveBeenCalled()
  io.distros = ['Ubuntu']
  expect(await rig.rpc()).toMatchObject({ success: true, models: [{ id: 'ubuntu-model' }] })
})

it('refuses a foreign runtime folder-backed repo through IPC and RPC before local environment or probe work', async () => {
  const foreign = fixture({
    repo: true,
    repoId: 'foreign',
    repoKind: 'folder',
    path: 'C:\\work\\app',
    executionHostId: 'runtime:other'
  })
  for (const read of [foreign.ipc, foreign.rpc]) {
    expect(await read()).toEqual({
      success: false,
      error: 'Terminal model discovery is unavailable on this connection.'
    })
  }
  expect(io.env).not.toHaveBeenCalled()
  expect(io.discover).not.toHaveBeenCalled()
  const local = fixture({
    repo: true,
    repoKind: 'folder',
    path: 'C:\\work\\app',
    executionHostId: 'local'
  })
  for (const read of [local.ipc, local.rpc]) {
    expect(await read()).toMatchObject({ success: true, models: [{ id: 'native-model' }] })
  }
  expect(io.env).toHaveBeenCalledTimes(2)
  expect(io.discover).toHaveBeenCalledTimes(2)
})
