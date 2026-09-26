import { describe, expect, it } from 'vitest'
import type { GlobalSettings } from '../../shared/global-settings-types'
import type { RpcContext } from './rpc/core'
import { GIT_METHODS } from './rpc/methods/git'
import { RuntimeGitCommands } from './orca-runtime-git'

const RPC_TO_RUNTIME_COMMAND = {
  'git.status': 'getRuntimeGitStatus',
  'git.checkIgnored': 'checkRuntimeGitIgnoredPaths',
  'git.submoduleStatus': 'getRuntimeGitSubmoduleStatus',
  'git.history': 'getRuntimeGitHistory',
  'git.conflictOperation': 'getRuntimeGitConflictOperation',
  'git.abortMerge': 'abortRuntimeGitMerge',
  'git.abortRebase': 'abortRuntimeGitRebase',
  'git.checkout': 'checkoutRuntimeGitBranch',
  'git.localBranches': 'listRuntimeGitLocalBranches',
  'git.diff': 'getRuntimeGitDiff',
  'git.branchDiff': 'getRuntimeGitBranchDiff',
  'git.commitDiff': 'getRuntimeGitCommitDiff',
  'git.branchCompare': 'getRuntimeGitBranchCompare',
  'git.commitCompare': 'getRuntimeGitCommitCompare',
  'git.upstreamStatus': 'getRuntimeGitUpstreamStatus',
  'git.fetch': 'fetchRuntimeGit',
  'git.forkSync': 'syncRuntimeGitForkDefaultBranch',
  'git.pull': 'pullRuntimeGit',
  'git.fastForward': 'fastForwardRuntimeGit',
  'git.rebaseFromBase': 'rebaseRuntimeGitFromBase',
  'git.push': 'pushRuntimeGit',
  'git.commit': 'commitRuntimeGit',
  'git.generateCommitMessage': 'generateRuntimeCommitMessage',
  'git.discoverCommitMessageModels': 'discoverRuntimeCommitMessageModels',
  'git.cancelGenerateCommitMessage': 'cancelRuntimeGenerateCommitMessage',
  'git.generatePullRequestFields': 'generateRuntimePullRequestFields',
  'git.cancelGeneratePullRequestFields': 'cancelRuntimeGeneratePullRequestFields',
  'git.stage': 'stageRuntimeGitPath',
  'git.bulkStage': 'bulkStageRuntimeGitPaths',
  'git.unstage': 'unstageRuntimeGitPath',
  'git.bulkUnstage': 'bulkUnstageRuntimeGitPaths',
  'git.discard': 'discardRuntimeGitPath',
  'git.bulkDiscard': 'bulkDiscardRuntimeGitPaths',
  'git.remoteFileUrl': 'getRuntimeGitRemoteFileUrl',
  'git.remoteCommitUrl': 'getRuntimeGitRemoteCommitUrl'
} as const satisfies Record<string, keyof RuntimeGitCommands>

/**
 * Records which runtime command a handler reaches for. A Proxy rather than a stub
 * of {@link RuntimeGitCommands} so a handler that calls a command nobody mapped is
 * recorded instead of throwing.
 */
function createCommandRecorder(): { calls: string[]; runtime: RpcContext['runtime'] } {
  const calls: string[] = []
  const runtime = new Proxy(
    {},
    {
      get: (_target, property) => () => {
        calls.push(String(property))
      }
    }
  ) as unknown as RpcContext['runtime']
  return { calls, runtime }
}

describe('runtime Git API contract', () => {
  it('keeps the registered Git RPC set and the runtime command map in step', () => {
    const commands = new RuntimeGitCommands({
      resolveRuntimeGitTarget: async () => {
        throw new Error('not called')
      },
      getRuntimeSettings: () => ({}) as GlobalSettings
    })
    const registeredMethods = GIT_METHODS.map((method) => method.name).sort()

    expect(registeredMethods).toEqual(Object.keys(RPC_TO_RUNTIME_COMMAND).sort())
    for (const commandName of Object.values(RPC_TO_RUNTIME_COMMAND)) {
      expect(commands[commandName]).toBeTypeOf('function')
    }
  })

  // Why this drives the handlers instead of reading the map: the map is a hand-kept
  // declaration of intent, and asserting only that its values name real methods leaves
  // every routing in it unverified -- `git.unstage` calling `stageRuntimeGitPath` passed.
  it('routes every registered Git RPC to the runtime command the map names', async () => {
    for (const method of GIT_METHODS) {
      const expected = RPC_TO_RUNTIME_COMMAND[method.name as keyof typeof RPC_TO_RUNTIME_COMMAND]
      const { calls, runtime } = createCommandRecorder()

      await method.handler({}, { runtime } as RpcContext)

      expect(calls, method.name).toEqual([expected])
    }
  })
})
