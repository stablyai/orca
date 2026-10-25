import './rpc/unused-default-rpc-methods.test-fixture'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { RpcDispatcher } from './rpc/dispatcher'
import { AGENT_SESSION_METHODS } from './rpc/methods/agent-session'
import { _resetWslCachesForTests, _setWslCachesForTests } from '../wsl'
import { PROJECT_RUNTIME_REPAIR_REQUIRED_CODE } from '../../shared/project-runtime-repair-message'
import {
  partialRuntimeStore,
  storeFolderWorkspace,
  storeProject,
  storeProjectGroup,
  storeRepo,
  type PartialRuntimeStore
} from './runtime-store-partial-fixture'

vi.mock('../opencode/opencode-launch-capabilities', () => ({
  probeOpenCodeLaunchCapabilities: async () => ({
    version: '1.18.30',
    pluginApi: 'v1',
    promptMode: 'submit'
  })
}))
vi.mock('../opencode/opencode-model-availability', () => ({
  probeOpenCodeModelAvailability: async () => true,
  resolveOpenCodeDirectModelExecutable: async () => 'opencode'
}))

const repo = storeRepo({ id: 'r', path: 'C:\\repo', kind: 'git', projectGroupId: 'g' })
const share = storeRepo({ id: 's', path: '\\\\wsl$\\Ubuntu\\s', kind: 'git', projectGroupId: 'g' })
const folder = storeFolderWorkspace({ id: 'f', projectGroupId: 'g', folderPath: 'C:\\work' })
const wsl = { kind: 'wsl', distro: 'Ubuntu' } as const
const store: PartialRuntimeStore = {
  // A WSL Terminal shell must not move the model check into WSL, as it did once.
  getSettings: () => ({
    disabledTuiAgents: [],
    terminalWindowsShell: 'wsl.exe',
    terminalWindowsWslDistro: 'Ubuntu'
  }),
  getProjects: () => [
    storeProject({ id: 'p', sourceRepoIds: ['r'], localWindowsRuntimePreference: wsl }),
    storeProject({
      id: 'q',
      sourceRepoIds: ['s'],
      localWindowsRuntimePreference: { kind: 'windows-host' }
    })
  ],
  getRepo: (id: string) => [repo, share].find((entry) => entry.id === id),
  getRepos: () => [repo],
  getFolderWorkspaces: () => [folder],
  getProjectGroups: () => [storeProjectGroup({ id: 'g' })]
}
const scope = { id: 'f', path: 'C:\\work', connectionId: null, repo: null, folderWorkspace: folder }
const clientOperationId = `${Date.now()}-0123456789abcdef0123456789abcdef`
let runtime: OrcaRuntimeService
let spawned: () => (string | undefined)[]
const original = process.platform
const setPlatform = (value: string) =>
  Object.defineProperty(process, 'platform', { configurable: true, value })
beforeEach(() => {
  setPlatform('win32')
  runtime = new OrcaRuntimeService(partialRuntimeStore(store))
  Object.assign(runtime, {
    resolveTerminalWorkspaceLaunchScope: async () => scope,
    executionOwnerSupportsAgentSessionOperation: async () => true
  })
  const launches: (string | undefined)[] = []
  // createTerminal up to its spawn: the runtime the host planner gave each launch.
  vi.spyOn(runtime, 'createTerminal').mockImplementation(async (selector = '', opts = {}) => {
    const launchScope = await runtime.resolveTerminalWorkspaceLaunchScope(selector)
    const planned = await runtime.resolveAgentTerminalCreateOptions(launchScope, opts)
    launches.push(planned.launchRuntime?.platform)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: callers read only the handle.
    return { handle: 't' } as never
  })
  spawned = () => launches
})
afterEach(() => {
  setPlatform(original)
  _resetWslCachesForTests()
})

// TEMPORARY until STA-10251: in a folder whose repo runs in WSL, OpenCode keeps main's Windows
// runtime at every entry point (create, resume, the worker's model check), so they agree.
it('starts, resumes and checks models for OpenCode in a WSL folder on Windows', async () => {
  await runtime.createAgentSession({ clientOperationId, worktree: 'id:f', agent: 'opencode' })
  const providerSession = { key: 'session_id', id: 'ses_1' } as const
  const resume = { kind: 'explicit', worktree: 'id:f', agent: 'opencode', providerSession } as const
  await runtime.ensureAgentSession(resume)
  expect(spawned()).toEqual(['win32', 'win32'])
  const target = { worktree: 'id:f', model: 'm' }
  expect(await runtime.probeOrchestrationOpenCodeModelLaunchSupport(target)).toBe(true)
})

// W5d: a folder whose repo's distro is gone is refused before any spawn, in the settings' words.
it('refuses an agent whose WSL distro is gone, under its own code', async () => {
  _setWslCachesForTests({ available: true, distros: ['Debian'] })
  const params = { clientOperationId, worktree: 'id:f', agent: 'codex' }
  const call = { id: '1', authToken: 't', method: 'terminal.createAgentSession', params }
  const response = await new RpcDispatcher({ runtime, methods: AGENT_SESSION_METHODS }).dispatch(
    call
  )
  const message =
    'No agent was started. Ubuntu is not installed in WSL. Choose an installed distro or switch this project to Windows.'
  expect(response).toMatchObject({ error: { code: PROJECT_RUNTIME_REPAIR_REQUIRED_CODE, message } })
})

// OpenCode runs in WSL in a `\\wsl$` repo, where Orca can't verify a model yet, so picking one is
// refused rather than checked on Windows.
it('refuses an OpenCode model in a WSL-share repo set to Windows host', async () => {
  const shareScope = { ...scope, id: 's', path: share.path, repo: share, folderWorkspace: null }
  Object.assign(runtime, { resolveTerminalWorkspaceLaunchScope: async () => shareScope })
  const request = { clientOperationId, worktree: 'id:s', agent: 'opencode' } as const
  const picked = runtime.createAgentSession({ ...request, launchPreferences: { model: 'm' } })
  await expect(picked).rejects.toThrow('cannot verify this OpenCode')
  expect(spawned()).toEqual([])
})
