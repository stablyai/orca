import { ipcMain } from 'electron'
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
import { readFloatingTerminalCwd } from '../floating-workspace-directory'

const fixture = createTerminalDiscoveryFixture(io)

it.each([3, 30])(
  'discovery of %i deferred fork scopes submits no preparation jobs or writes',
  async (count) => {
    const rig = fixture({ repo: true, deferred: true, unstamped: true })
    io.rows = Array.from({ length: count }, (_unused, index) => ({
      path: `C:\\fork-${index}`,
      head: 'abc',
      branch: 'fix',
      isBare: false,
      isMainWorktree: index === 0
    }))
    for (const row of io.rows) {
      await rig.runtime.discoverTerminalModels(`path:${row.path}`, 'antigravity')
    }
    await rig.runtime.discoverTerminalModels('path:C:\\fork-0', 'antigravity')
    io.discover.mockResolvedValueOnce({ success: false, error: 'offline' })
    await rig.runtime.discoverTerminalModels('path:C:\\fork-0', 'antigravity')
    await Promise.resolve()
    expect(io.materialize.mock.calls).toEqual([])
    expect(io.mutations.mock.calls).toEqual([])
    expect(io.userAct.mock.calls).toEqual([])
    // The real launch wrapper still prepares this exact registered deferred fork.
    await rig.runtime.resolveTerminalWorkspaceLaunchScope('path:C:\\fork-0')
    expect(io.materialize).toHaveBeenCalledWith(
      'C:\\fork-0',
      {
        remoteName: 'contributor',
        branchName: 'fix',
        remoteCreated: false,
        remoteUrl: 'https://example.com/contributor/repo.git'
      },
      expect.anything(),
      'repo',
      {},
      expect.anything()
    )
  }
)

it('read-only floating selection never creates or trusts a missing fallback directory', async () => {
  fixture()
  // Filesystem failure is the external boundary, not a replacement scope policy.
  const spy = vi
    .spyOn(await import('node:fs/promises'), 'stat')
    .mockRejectedValue(new Error('ENOENT'))
  await expect(
    readFloatingTerminalCwd({ getSettings: () => ({}) }, { path: '/missing' })
  ).rejects.toThrow('floating_workspace_path_unavailable')
  expect(io.mutations).not.toHaveBeenCalled()
  spy.mockRestore()
})

it('replaces the discovery handler when the main window registers again', async () => {
  const registered = new Set<string>()
  io.handle.mockImplementation((channel: string) => {
    if (registered.has(channel)) {
      throw new Error('Attempted to register a second handler')
    }
    registered.add(channel)
  })
  vi.mocked(ipcMain.removeHandler).mockImplementation((channel) => {
    registered.delete(channel)
  })
  try {
    fixture({ platform: 'darwin' })
    const reopened = fixture({ platform: 'darwin' })
    await expect(reopened.ipc()).resolves.toMatchObject({
      origin: 'probe',
      models: [{ id: 'native-model' }]
    })
  } finally {
    io.handle.mockReset()
    vi.mocked(ipcMain.removeHandler).mockReset()
  }
})
