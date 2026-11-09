import { expect, it } from 'vitest'
import { fixture, io } from './terminal-model-discovery.test-fixture'
import { GIT_COMMIT_MESSAGE_GENERATION_METHODS } from '../../runtime/rpc/methods/source-control/git/git-commit-message-generation-methods'
import { registerFilesystemGitModelDiscoveryHandlers } from './filesystem-git-model-discovery-handlers'
import { resolveAgentLaunchRuntime } from '../../runtime/terminal/launch/agent-launch-scope-runtime'

it('keeps terminal Ubuntu inventory separate from native Git discovery and commit/PR generation', async () => {
  const rig = fixture({
    repo: true,
    runtime: { kind: 'wsl', distro: 'Ubuntu', git: 'windows-host' }
  })
  expect(await rig.rpc()).toMatchObject({ models: [{ id: 'ubuntu-model' }] })
  const git = GIT_COMMIT_MESSAGE_GENERATION_METHODS.find(
    ({ name }) => name === 'git.discoverCommitMessageModels'
  )!
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: each method reads the real runtime; dispatcher context ports are not needed.
  const context = { runtime: rig.runtime } as never
  expect(
    await git.handler({ worktree: rig.selector, agentId: 'antigravity' } as never, context)
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
  const rig = fixture({ runtime: { kind: 'wsl', distro: '', git: 'windows-host' } })
  expect(await rig.ipc()).toMatchObject({ success: false })
  const target = await rig.runtime.resolveTerminalWorkspaceReadTarget(rig.selector)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this fixture supplies the real launch resolver's store reads.
  expect(() =>
    resolveAgentLaunchRuntime(rig.store as never, target.scope, undefined, 'antigravity')
  ).toThrow('No agent was started.')
  expect(io.env).not.toHaveBeenCalled()
  expect(io.discover).not.toHaveBeenCalled()
})

it('settles the existing Git repair refusal without probing or falling back to host execution', async () => {
  const runtime = { kind: 'wsl' as const, distro: 'Ubuntu', git: 'windows-host' as const }
  const rig = fixture({ repo: true, runtime })
  await rig.runtime.discoverRuntimeCommitMessageModels(rig.selector, 'antigravity')
  io.env.mockClear()
  io.discover.mockClear()
  runtime.distro = ''
  expect(
    await rig.runtime.discoverRuntimeCommitMessageModels(rig.selector, 'antigravity')
  ).toMatchObject({ success: false })
  expect(io.env).not.toHaveBeenCalled()
  expect(io.discover).not.toHaveBeenCalled()
})
