import { afterEach, beforeEach, vi, type Mock } from 'vitest'
import type { WorktreeMeta } from '../../../shared/worktree/meta-types'
import { OrcaRuntimeService } from '../../runtime/orca-runtime'
import { getDefaultWorkspaceSession } from '../../../shared/constants'
import { registerTerminalModelDiscoveryHandler } from '../terminal-model-discovery'
import { AGENT_MODEL_DISCOVERY_METHODS } from '../../runtime/rpc/methods/terminal/agent-model-discovery'

export const FOLDER_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
export type DiscoveryIO = {
  generateCommit: Mock
  generatePr: Mock
  handle: Mock
  env: Mock
  discover: Mock
  materialize: Mock
  distros: string[]
  distrosKnown: boolean
  rows: {
    path: string
    head: string
    branch: string
    isBare: boolean
    isMainWorktree: boolean
  }[]
  mutations: Mock
  userAct: Mock
}

export function createTerminalDiscoveryFixture(io: DiscoveryIO) {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
  afterEach(() => {
    Object.defineProperty(process, 'platform', platform)
    vi.clearAllMocks()
  })
  beforeEach(() => {
    io.distros = ['Ubuntu']
    io.distrosKnown = false
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
  return function fixture(
    options: {
      platform?: NodeJS.Platform
      path?: string
      shell?: string
      distro?: string
      repo?: boolean
      repoKind?: 'folder'
      repoId?: string
      executionHostId?: string
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
      id: options.repoId ?? 'repo',
      ...(options.repoKind ? { kind: options.repoKind } : {}),
      path,
      projectGroupId: 'group',
      connectionId: null,
      executionHostId: options.executionHostId ?? 'local'
    }
    const id = `${repo.id}::${path}`
    const pushTarget = {
      remoteName: 'contributor',
      branchName: 'fix',
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
    const metadata = new Map<string, Partial<WorktreeMeta>>()
    const initialMeta = (): Partial<WorktreeMeta> => ({
      ...(options.unstamped ? {} : { instanceId: 'fixture-instance' }),
      ...(options.deferred ? { pushTarget } : {})
    })
    const getWorktreeMeta = (id: string) => metadata.get(id) ?? initialMeta()
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
      getProjectGroups: () => [
        { id: 'group', name: 'Group', parentPath: path, connectionId: null }
      ],
      getFolderWorkspaces: () => [folder],
      getWorktreeMeta,
      getAllWorktreeMeta: () =>
        Object.fromEntries(
          io.rows.map((row) => [`repo::${row.path}`, getWorktreeMeta(`repo::${row.path}`)])
        ),
      setWorktreeMeta: (target: { id: string }, patch: Partial<WorktreeMeta>) => {
        io.mutations(target, patch)
        const meta = { ...getWorktreeMeta(target.id), ...patch, instanceId: 'fixture-instance' }
        metadata.set(target.id, meta)
        return meta
      },
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
}
