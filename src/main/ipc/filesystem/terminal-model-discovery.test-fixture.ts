import { afterEach, beforeEach, vi } from 'vitest'
export const io = vi.hoisted(() => ({
  generateCommit: vi.fn(),
  generatePr: vi.fn(),
  handle: vi.fn(),
  env: vi.fn(),
  discover: vi.fn(),
  materialize: vi.fn(),
  distros: ['Ubuntu'] as string[],
  rows: [] as {
    path: string
    head: string
    branch: string
    isBare: boolean
    isMainWorktree: boolean
  }[],
  mutations: vi.fn(),
  userAct: vi.fn()
}))
vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/pr40175-terminal-discovery', isPackaged: false },
  ipcMain: { handle: io.handle }
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
  hasCachedWslDistros: () => false,
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
import { OrcaRuntimeService } from '../../runtime/orca-runtime'
import { getDefaultWorkspaceSession } from '../../../shared/constants'
import { registerTerminalModelDiscoveryHandler } from '../terminal-model-discovery'
import { AGENT_MODEL_DISCOVERY_METHODS } from '../../runtime/rpc/methods/terminal/agent-model-discovery'

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
afterEach(() => {
  Object.defineProperty(process, 'platform', platform)
  vi.clearAllMocks()
})
beforeEach(() => {
  io.distros = ['Ubuntu']
  io.rows = []
  io.materialize.mockResolvedValue(undefined)
  io.generateCommit.mockResolvedValue({ success: true, message: 'Commit' })
  io.generatePr.mockResolvedValue({ success: true, fields: { title: 'PR', body: 'Body' } })
  io.env.mockImplementation(async (_agent, _resolver, target) => ({
    ok: true,
    env: { MODEL_CONTEXT: target.wslDistro ?? 'native' }
  }))
  io.discover.mockImplementation(async (_agent, env) => ({
    success: true,
    catalogOrigin: 'probe',
    defaultModelId: '',
    capability: {},
    models: [
      {
        id:
          env.MODEL_CONTEXT === 'Ubuntu'
            ? 'ubuntu-model'
            : env.MODEL_CONTEXT === 'Debian'
              ? 'debian-model'
              : 'native-model',
        label: 'Listed'
      }
    ]
  }))
})
export const FOLDER_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
export function fixture(
  options: {
    platform?: NodeJS.Platform
    path?: string
    shell?: string
    distro?: string
    repo?: boolean
    runtime?: { kind: 'wsl'; distro: string; git: 'windows-host' } | { kind: 'windows-host' }
    unstamped?: boolean
    deferred?: boolean
  } = {}
) {
  Object.defineProperty(process, 'platform', {
    configurable: true,
    value: options.platform ?? 'win32'
  })
  const path = options.path ?? 'C:\\plain'
  const repo = {
    id: 'repo',
    path,
    projectGroupId: 'group',
    connectionId: null,
    executionHostId: 'local'
  }
  const id = `repo::${path}`
  const pushTarget = {
    remote: 'contributor',
    branch: 'fix',
    remoteCreated: false,
    remoteUrl: 'https://example.com/contributor/repo.git'
  }
  const folder = {
    id: FOLDER_ID,
    folderPath: path,
    projectGroupId: 'group',
    executionHostId: 'local',
    name: 'plain'
  }
  const settings = {
    terminalWindowsShell: options.shell ?? 'powershell.exe',
    terminalWindowsWslDistro: options.distro
  }
  io.rows = [{ path, head: 'abc', branch: 'fix', isBare: false, isMainWorktree: true }]
  const store = {
    getSettings: () => settings,
    getRepos: () => (options.repo || options.runtime ? [repo] : []),
    getRepo: () => (options.repo || options.runtime ? repo : undefined),
    getProjects: () =>
      options.runtime
        ? [
            {
              id: 'project',
              sourceRepoIds: ['repo'],
              localWindowsRuntimePreference: options.runtime
            }
          ]
        : [],
    getProjectGroups: () => [{ id: 'group', name: 'Group', parentPath: path, connectionId: null }],
    getFolderWorkspaces: () => [folder],
    getWorktreeMeta: () => ({
      ...(options.unstamped ? {} : { instanceId: 'fixture-instance' }),
      ...(options.deferred ? { pushTarget } : {})
    }),
    getAllWorktreeMeta: () =>
      Object.fromEntries(
        io.rows.map((row) => [
          `repo::${row.path}`,
          {
            ...(options.unstamped ? {} : { instanceId: 'fixture-instance' }),
            ...(options.deferred ? { pushTarget } : {})
          }
        ])
      ),
    setWorktreeMeta: io.mutations,
    updateSettings: io.mutations,
    getWorkspaceSession: getDefaultWorkspaceSession,
    getAllWorktreeLineage: () => ({}),
    flushOrThrow: () => {}
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: discovery uses these read ports; mutations are recorded separately.
  const runtime = new OrcaRuntimeService(store as never)
  registerTerminalModelDiscoveryHandler(runtime)
  const ipc = io.handle.mock.calls.at(-1)![1]
  const selector = options.repo ? `id:${id}` : `id:folder:${FOLDER_ID}`
  const rpc = () =>
    AGENT_MODEL_DISCOVERY_METHODS[0].handler(
      { worktree: selector, agentId: 'antigravity' },
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the real method only reads the runtime from this context.
      { runtime } as never
    )
  return {
    runtime,
    store,
    settings,
    path,
    id,
    selector,
    rpc,
    ipc: () => ipc(null, { worktree: selector, agentId: 'antigravity' })
  }
}
