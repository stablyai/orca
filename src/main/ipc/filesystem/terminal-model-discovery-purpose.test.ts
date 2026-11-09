import { GitDiscoverCommitMessageModels } from '../../../shared/rpc-contract/git-params'
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
import { GIT_COMMIT_MESSAGE_GENERATION_METHODS } from '../../runtime/rpc/methods/source-control/git/git-commit-message-generation-methods'
import { registerFilesystemGitModelDiscoveryHandlers } from './filesystem-git-model-discovery-handlers'
import { resolveAgentLaunchRuntime } from '../../runtime/terminal/launch/agent-launch-scope-runtime'

const fixture = createTerminalDiscoveryFixture(io)

it('keeps terminal Ubuntu inventory separate from native Git discovery and commit/PR generation', async () => {
  const rig = fixture({
    repo: true,
    runtime: { kind: 'wsl', distro: 'Ubuntu', git: 'windows-host' }
  })
  expect(await rig.rpc()).toMatchObject({ models: [{ id: 'ubuntu-model' }] })
  const git = GIT_COMMIT_MESSAGE_GENERATION_METHODS.find(
    (
      method
    ): method is Extract<
      (typeof GIT_COMMIT_MESSAGE_GENERATION_METHODS)[number],
      { params: typeof GitDiscoverCommitMessageModels }
    > => method.params === GitDiscoverCommitMessageModels
  )!
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: each method reads the real runtime; dispatcher context ports are not needed.
  const context = { runtime: rig.runtime } as never
  expect(
    await git.handler({ worktree: rig.selector, agentId: 'antigravity' }, context)
  ).toMatchObject({ success: true, models: [{ id: 'native-model' }] })
  const override = {
    sourceControlAiResolvedParams: {
      agentId: 'antigravity' as const,
      model: 'native-selected-literal'
    }
  }
  await rig.runtime.generateRuntimeCommitMessage(rig.selector, override)
  await rig.runtime.generateRuntimePullRequestFields(
    rig.selector,
    { base: 'main', title: '', body: '', draft: true, useTemplate: false },
    override
  )
  for (const call of [io.generateCommit.mock.calls.at(-1), io.generatePr.mock.calls.at(-1)]) {
    expect(call?.[1]).toEqual({ agentId: 'antigravity', model: 'native-selected-literal' })
    expect(call?.[2]).toEqual({ kind: 'local', cwd: rig.path, env: { MODEL_CONTEXT: 'native' } })
  }
  // Local text-action cards deliberately use the unchanged host-global request shape.
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handler only reads this fixture's store and environment.
  registerFilesystemGitModelDiscoveryHandlers({ store: rig.store } as never)
  const local = io.handle.mock.calls.find(
    ([name]) => name === 'git:discoverCommitMessageModels'
  )![1]
  expect(
    await local(null, { agentId: 'antigravity', worktreePath: '', connectionId: undefined })
  ).toMatchObject({ models: [{ id: 'native-model' }] })
  expect(io.discover.mock.calls.at(-1)).toEqual([
    'antigravity',
    { MODEL_CONTEXT: 'native' },
    undefined
  ])
})

it('settles a terminal repair refusal before preparing an environment or probing', async () => {
  const rig = fixture({ runtime: { kind: 'wsl', distro: 'Ubuntu', git: 'windows-host' } })
  io.distrosKnown = true
  io.distros = []
  expect(await rig.ipc()).toMatchObject({ success: false })
  const target = await rig.runtime.resolveTerminalWorkspaceReadTarget(rig.selector)
  expect(() => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this read-port fixture supplies the launch resolver's store reads, as for the real runtime constructor.
    return resolveAgentLaunchRuntime(rig.store as never, target.scope, undefined, 'antigravity')
  }).toThrow('No agent was started.')
  expect(io.env).not.toHaveBeenCalled()
  expect(io.discover).not.toHaveBeenCalled()
})

it('settles the existing Git repair refusal without probing or falling back to host execution', async () => {
  const runtime = { kind: 'wsl' as const, distro: 'Ubuntu', git: 'windows-host' as const }
  const rig = fixture({ repo: true, runtime })
  expect(
    await rig.runtime.discoverRuntimeCommitMessageModels(`path:${rig.path}`, 'antigravity')
  ).toMatchObject({ success: true, models: [{ id: 'native-model' }] })
  io.env.mockClear()
  io.discover.mockClear()
  io.distrosKnown = true
  io.distros = []
  expect(
    await rig.runtime.discoverRuntimeCommitMessageModels(rig.selector, 'antigravity')
  ).toMatchObject({ success: false })
  expect(io.env).not.toHaveBeenCalled()
  expect(io.discover).not.toHaveBeenCalled()
})
