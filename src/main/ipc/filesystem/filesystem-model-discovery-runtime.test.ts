import { afterEach, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ handle: vi.fn(), env: vi.fn(), discover: vi.fn() }))
vi.mock('electron', () => ({
  app: { getPath: () => '/tmp', isPackaged: false },
  ipcMain: { handle: mocks.handle }
}))
vi.mock('../../text-generation/commit-message-agent-environment', () => ({
  prepareLocalCommitMessageAgentEnv: mocks.env
}))
vi.mock('../../text-generation/commit-message-text-generation', () => ({
  discoverCommitMessageModelsLocal: mocks.discover
}))
vi.mock('./filesystem-source-control-ai-targets', async (original) => ({
  ...(await original<object>()),
  resolveModelDiscoveryLocalPath: async (_store: unknown, path: string) => path
}))
vi.mock('../../wsl/discovery/wsl-availability', () => ({ hasCachedWslAvailability: () => false }))
vi.mock('../../wsl/discovery/distro-catalog', () => ({ hasCachedWslDistros: () => false }))
import { registerFilesystemGitModelDiscoveryHandlers } from './filesystem-git-model-discovery-handlers'
import { RuntimeWorkspaceFileTargets } from '../../runtime/workspaces/workspace-file-session-targets'
import { RuntimeGitGenerationCommands } from '../../runtime/integrations/git/runtime-git-generation-commands'

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
afterEach(() => {
  Object.defineProperty(process, 'platform', platform)
  vi.clearAllMocks()
})

it.each(['repo', 'folder'] as const)(
  'discovers in the terminal agent runtime for Windows-spelled %s paths with Windows Git',
  async (kind) => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    const repo = { id: 'repo', path: 'C:\\work\\app', projectGroupId: 'group', connectionId: null }
    const folder = {
      id: 'folder',
      folderPath: 'C:\\work\\app\\folder',
      projectGroupId: 'group',
      executionHostId: 'local'
    }
    const path = kind === 'repo' ? repo.path : folder.folderPath
    const scope = {
      id: kind === 'repo' ? 'repo' : 'folder:folder',
      path,
      connectionId: null,
      repo: kind === 'repo' ? repo : null,
      folderWorkspace: kind === 'folder' ? folder : null
    }
    const store = {
      getSettings: () => ({}),
      getRepos: () => [repo],
      getRepo: () => repo,
      getProjects: () => [
        {
          id: 'project',
          sourceRepoIds: ['repo'],
          localWindowsRuntimePreference: { kind: 'wsl', distro: 'Ubuntu', git: 'windows-host' }
        }
      ],
      getProjectGroups: () => [{ id: 'group', parentPath: repo.path, connectionId: null }],
      getFolderWorkspaces: () => [folder],
      getAllWorktreeMeta: () => ({})
    }
    mocks.env.mockResolvedValue({ ok: true, env: {} })
    mocks.discover.mockResolvedValue({
      success: true,
      models: [{ id: 'guest-model', label: 'Guest model' }]
    })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fixture supplies only the store and environment reads this handler makes.
    registerFilesystemGitModelDiscoveryHandlers({ store } as never)
    const handler = mocks.handle.mock.calls.find(
      ([channel]) => channel === 'git:discoverCommitMessageModels'
    )![1]
    expect(await handler(null, { agentId: 'antigravity', worktreePath: path })).toMatchObject({
      models: [{ id: 'guest-model' }]
    })
    expect(mocks.env).toHaveBeenCalledWith('antigravity', undefined, {
      runtime: 'wsl',
      wslDistro: 'Ubuntu'
    })
    expect(mocks.discover).toHaveBeenCalledWith('antigravity', {}, undefined, {
      cwd: path,
      wslDistro: 'Ubuntu'
    })
    mocks.env.mockClear()
    mocks.discover.mockClear()
    // The paired host uses its real discovery-target resolver and the same launch policy; scope acquisition has no disk fixture.
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: expose the protected target resolver to drive its transport boundary.
    const resolve = (
      RuntimeWorkspaceFileTargets.prototype as unknown as {
        resolveRuntimeModelDiscoveryTarget: (selector: string, agent: string) => Promise<never>
      }
    ).resolveRuntimeModelDiscoveryTarget
    const host = {
      requireStore: () => store,
      resolveTerminalWorkspaceLaunchScope: async () => scope,
      folderWorkspaceToResolvedWorktree: () => ({ id: scope.id, path }),
      resolveGitWorktreeSelector: async () => ({ id: scope.id, path })
    }
    const commands = new RuntimeGitGenerationCommands({
      resolveRuntimeModelDiscoveryTarget: (selector, agent) => resolve.call(host, selector, agent!),
      resolveRuntimeGitTarget: async () => {
        throw new Error('Git routing must not choose the agent runtime')
      },
      getRuntimeSettings: () => ({})
    })
    expect(
      await commands.discoverRuntimeCommitMessageModels(`id:${scope.id}`, 'antigravity')
    ).toMatchObject({ models: [{ id: 'guest-model' }] })
    expect(mocks.env).toHaveBeenCalledWith('antigravity', undefined, {
      runtime: 'wsl',
      wslDistro: 'Ubuntu'
    })
    expect(mocks.discover).toHaveBeenCalledWith('antigravity', {}, undefined, {
      cwd: path,
      wslDistro: 'Ubuntu'
    })
  }
)
