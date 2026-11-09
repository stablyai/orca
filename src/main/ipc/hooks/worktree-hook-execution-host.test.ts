import { beforeEach, expect, it, vi } from 'vitest'
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
vi.mock('../../workspace-hooks/hooks', () => ({
  hasHooksFile: mocks.hasHooks,
  loadHooks: mocks.loadHooks,
  getEffectiveHooks: mocks.effectiveHooks,
  hasUnrecognizedOrcaYamlKeys: () => false,
  parseOrcaYaml: () => ({ issueCommand: 'shared' })
}))
vi.mock('../../workspace-hooks/issue-command-file', () => ({
  readIssueCommandUnlessWslStopped: mocks.localRead,
  writeIssueCommandUnlessWslStopped: mocks.localWrite
}))
vi.mock('../../workspaces/execution-host/project-runtime-git-options', () => ({
  getLocalProjectWorktreeGitOptions: () => ({})
}))
vi.mock('node:fs/promises', () => ({
  readFile: mocks.localFileRead,
  stat: mocks.localStat
}))
vi.mock('../../../shared/workspace-setup/setup-script-imports', () => ({
  inspectSetupScriptImportCandidates: async (
    read: (path: string) => Promise<unknown>,
    options?: { fileExists: (path: string) => Promise<boolean> }
  ) => {
    await read('setup.sh')
    await options?.fileExists('package.json')
    return []
  }
}))
vi.mock('../../workspace-hooks/effective-hook-config', () => ({
  getEffectiveSetupRunPolicy: () => 'manual'
}))

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

// This process must inspect SSH-owned repos neither remotely nor locally.

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
