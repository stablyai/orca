import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../shared/repo-types'
import { hydrateRepo } from '../../persistence/tracking-repos/repo-hydration'

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, args: unknown) => unknown>(),
  hasHooks: vi.fn(),
  loadHooks: vi.fn(),
  effectiveHooks: vi.fn(),
  localRead: vi.fn(),
  localWrite: vi.fn(),
  localFileRead: vi.fn(),
  localStat: vi.fn()
}))
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, args: unknown) => unknown) =>
      mocks.handlers.set(channel, handler)
  }
}))
vi.mock('../../hooks', () => ({
  hasHooksFile: mocks.hasHooks,
  loadHooks: mocks.loadHooks,
  getEffectiveHooks: mocks.effectiveHooks,
  hasUnrecognizedOrcaYamlKeys: () => false,
  parseOrcaYaml: () => ({ issueCommand: 'shared' })
}))
vi.mock('../../issue-command-file', () => ({
  readIssueCommand: mocks.localRead,
  writeIssueCommand: mocks.localWrite
}))
vi.mock('../../project-runtime-git-options', () => ({
  getLocalProjectWorktreeGitOptions: () => ({})
}))
vi.mock('node:fs/promises', () => ({
  readFile: mocks.localFileRead,
  stat: mocks.localStat
}))
vi.mock('../../../shared/setup-script-imports', () => ({
  inspectSetupScriptImportCandidates: async (
    read: (path: string) => Promise<unknown>,
    options?: { fileExists: (path: string) => Promise<boolean> }
  ) => {
    await read('setup.sh')
    await options?.fileExists('package.json')
    return []
  }
}))
vi.mock('../../effective-hook-config', () => ({
  getEffectiveSetupRunPolicy: () => 'manual',
  getDefaultTabCommandTrustContent: () => undefined
}))
import { RuntimeRepositoryHooksCommands } from '../../runtime/runtime-repository-hooks-commands'
import { RuntimeRepositoryIssueCommand } from '../../runtime/runtime-repository-issue-command'
import { getRepoExecutionHostId } from '../../../shared/execution-host'
import { registerWorktreeHookCheckHandler } from './register-worktree-hook-check-handler'
import { registerWorktreeHookFileHandlers } from './register-worktree-hook-file-handlers'
import { registerWorktreeHookInspectionHandler } from './register-worktree-hook-inspection-handler'

beforeEach(() => {
  vi.clearAllMocks()
  mocks.handlers.clear()
  mocks.localRead.mockResolvedValue({ localContent: 'wrong host' })
  mocks.localWrite.mockResolvedValue(undefined)
  mocks.localFileRead.mockResolvedValue('wrong host')
  mocks.localStat.mockResolvedValue({ isDirectory: () => false })
  mocks.hasHooks.mockReturnValue(false)
})

const owners = [
  { label: 'legacy SSH', fields: { connectionId: 'host-a' }, target: 'host-a' },
  { label: 'canonical SSH', fields: { executionHostId: 'ssh:host-a' }, target: 'host-a' },
  {
    label: 'canonical SSH over stale legacy target',
    fields: { executionHostId: 'ssh:host-a', connectionId: 'stale' },
    target: 'host-a'
  },
  { label: 'local', fields: {}, target: null },
  {
    label: 'explicit local over stale legacy target',
    fields: { executionHostId: 'local', connectionId: 'stale' },
    target: null
  },
  { label: 'own-store runtime stamp', fields: { executionHostId: 'runtime:env' }, target: null },
  {
    label: 'runtime stamp with nested legacy target',
    fields: { executionHostId: 'runtime:env', connectionId: 'nested' },
    target: null
  }
] as const satisfies readonly {
  label: string
  fields: Pick<Repo, 'connectionId' | 'executionHostId'>
  target: string | null
}[]

const channels = [
  'hooks:check',
  'hooks:readIssueCommand',
  'hooks:writeIssueCommand',
  'hooks:inspectSetupScriptImports'
] as const

function register(repo: Repo): void {
  const context = { store: { getRepos: () => [repo], getRepo: () => repo } }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: These adapters only read the provided store accessors.
  registerWorktreeHookCheckHandler(context as never)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: These adapters only read the provided store accessors.
  registerWorktreeHookFileHandlers(context as never)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: These adapters only read the provided store accessors.
  registerWorktreeHookInspectionHandler(context as never)
}

function makeRepo(fields: Pick<Repo, 'connectionId' | 'executionHostId'>): Repo {
  return hydrateRepo(
    {
      id: 'repo',
      path: '/remote/fixture',
      displayName: 'fixture',
      badgeColor: '#000',
      addedAt: 0,
      ...fields
    },
    new Map()
  )
}

const localCalls = [
  mocks.hasHooks,
  mocks.localRead,
  mocks.localWrite,
  mocks.localFileRead,
  mocks.localStat,
  mocks.effectiveHooks
]

// Why: this process serves no SSH filesystem, so an SSH owner is neither read remotely nor locally.
function expectRoute(target: string | null): void {
  if (target) {
    for (const method of localCalls) {
      expect(method).not.toHaveBeenCalled()
    }
  } else {
    expect(localCalls.some((method) => method.mock.calls.length > 0)).toBe(true)
  }
}

describe.each(owners)('desktop hooks: $label', ({ fields, target }) => {
  it.each(channels)('routes %s to the stored owner', async (channel) => {
    const repo = makeRepo(fields)
    register(repo)
    const result = Promise.resolve(
      mocks.handlers.get(channel)!(null, {
        repoId: repo.id,
        hostId: getRepoExecutionHostId(repo),
        content: 'save'
      })
    )
    await (channel === 'hooks:writeIssueCommand' && target
      ? expect(result).rejects.toThrow('Remote filesystem unavailable')
      : result)
    expectRoute(target)
  })
})

describe.each(owners)('runtime hooks: $label', ({ fields, target }) => {
  it.each(['get', 'check', 'inspect', 'read', 'write'] as const)(
    'routes %s to the stored owner',
    async (method) => {
      const repo = makeRepo(fields)
      const hooks = new RuntimeRepositoryHooksCommands({ resolveRepo: async () => repo })
      const issue = new RuntimeRepositoryIssueCommand({
        resolveRepo: async () => repo,
        getLocalGitArgs: () => []
      })
      if (method === 'get') {
        await hooks.getRepoHooks(repo.id)
      } else if (method === 'check') {
        await hooks.checkRepoHooks(repo.id)
      } else if (method === 'inspect') {
        await hooks.inspectRepoSetupScriptImports(repo.id)
      } else if (method === 'read') {
        await issue.read(repo.id)
      } else {
        await issue.write(repo.id, 'save')
      }
      expectRoute(target)
    }
  )
})

it('refuses an unreachable canonical SSH write without touching local files', async () => {
  const repo = makeRepo({ executionHostId: 'ssh:host-a' })
  register(repo)
  await expect(
    mocks.handlers.get('hooks:writeIssueCommand')!(null, {
      repoId: repo.id,
      hostId: 'ssh:host-a',
      content: 'save'
    })
  ).rejects.toThrow('Remote filesystem unavailable')
  expect(mocks.localWrite).not.toHaveBeenCalled()
})

it.each(channels)('keeps folder repositories out of %s', async (channel) => {
  const repo = { ...makeRepo({ executionHostId: 'ssh:host-a' }), kind: 'folder' as const }
  register(repo)
  await mocks.handlers.get(channel)!(null, {
    repoId: repo.id,
    hostId: 'ssh:host-a',
    content: 'save'
  })
  expect(mocks.hasHooks).not.toHaveBeenCalled()
  expect(mocks.localRead).not.toHaveBeenCalled()
  expect(mocks.localWrite).not.toHaveBeenCalled()
  expect(mocks.localFileRead).not.toHaveBeenCalled()
})
