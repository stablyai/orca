import type { Repo } from '../../../../shared/repository/repo-types'
import type { Store } from '../../../persistence/loading-store/store'
import type { OrcaRuntimeService } from '../../../runtime/orca-runtime'
import { withAmbientGitHubAccount } from '../../../github/repositories/github-repository-identity'
import { RuntimeGitCommands } from '../../../runtime/integrations/git/orca-runtime-git'
import type { RuntimeGitCommandHost } from '../../../runtime/integrations/git/runtime-git-command-target'
import { RuntimeGitHubRepositoryQueryCommands } from '../../../runtime/integrations/github/runtime-github-repository-query-commands'
import { RuntimeGitHubReviewQueryCommands } from '../../../runtime/integrations/github/runtime-github-review-query-commands'
import { RuntimeGitHubReviewMutationCommands } from '../../../runtime/integrations/github/runtime-github-review-mutation-commands'
import { RuntimeGitHubIssueCommentCommands } from '../../../runtime/integrations/github/runtime-github-issue-comment-commands'
import { RuntimeGitHubProjectCommands } from '../../../runtime/integrations/github/runtime-github-project-commands'
import { RuntimeGitLabQueryCommands } from '../../../runtime/integrations/gitlab/runtime-gitlab-query-commands'
import { RuntimeGitLabMutationCommands } from '../../../runtime/integrations/gitlab/runtime-gitlab-mutation-commands'
import { RuntimeHostedReviewCommands } from '../../../runtime/integrations/reviews/runtime-hosted-review-commands'
import { GIT_METHODS } from '../../../runtime/rpc/methods/source-control/git/git'
import { GITHUB_METHODS } from '../../../runtime/rpc/methods/source-control/github/github'
import { GITLAB_METHODS } from '../../../runtime/rpc/methods/source-control/gitlab/gitlab'
import { HOSTED_REVIEW_METHODS } from '../../../runtime/rpc/methods/source-control/reviews/hosted-review'
import { CLIPBOARD_METHODS } from '../../../runtime/rpc/methods/clipboard/clipboard'
import type { LocalProjectGhExecOptions } from '../../../workspaces/execution-host/project-runtime-git-options'
import {
  createLocalSourceControlTargets,
  type LocalSourceControlWorktree
} from './local-source-control-targets'

export const LOCAL_SOURCE_CONTROL_METHODS = [
  ...GIT_METHODS,
  ...GITHUB_METHODS,
  ...GITLAB_METHODS,
  ...HOSTED_REVIEW_METHODS,
  ...CLIPBOARD_METHODS
]

const supportedMethods = new Set<string>(LOCAL_SOURCE_CONTROL_METHODS.map((method) => method.name))

const remoteContextMethods = new Set([
  'github.listBindableAccounts',
  'github.validateAccountBinding',
  'git.branchSwitchBlocker',
  'git.recordBranchSwitched',
  'git.generateCommitMessage',
  'git.generatePullRequestFields',
  'git.discoverCommitMessageModels',
  'git.cancelGenerateCommitMessage',
  'git.cancelGeneratePullRequestFields'
])

export function isLocalSourceControlMethod(method: string): boolean {
  return (
    supportedMethods.has(method) &&
    !method.startsWith('clipboard.') &&
    !remoteContextMethods.has(method)
  )
}

const gitMutationMethods = new Set([
  'abortRuntimeGitMerge',
  'abortRuntimeGitRebase',
  'checkoutRuntimeGitBranch',
  'switchRuntimeGitBranch',
  'fetchRuntimeGit',
  'syncRuntimeGitForkDefaultBranch',
  'pullRuntimeGit',
  'fastForwardRuntimeGit',
  'rebaseRuntimeGitFromBase',
  'pushRuntimeGit',
  'commitRuntimeGit',
  'createRuntimeGitBranch',
  'cherryPickRuntimeGit',
  'revertRuntimeGit',
  'sequencerAbortRuntimeGit',
  'sequencerContinueRuntimeGit',
  'completeRuntimeGitMerge',
  'stageRuntimeGitPath',
  'resolveRuntimeGitConflict',
  'unstageRuntimeGitPath',
  'bulkStageRuntimeGitPaths',
  'bulkUnstageRuntimeGitPaths',
  'bulkDiscardRuntimeGitPaths',
  'discardRuntimeGitPath'
])

export type LocalSourceControlRuntimeOptions = {
  runtime: OrcaRuntimeService
  store: Store
  repos: Repo[]
  worktrees: LocalSourceControlWorktree[]
  getSignal?: () => AbortSignal | undefined
  onMutation?: () => void | Promise<void>
  gitHost?: Pick<
    RuntimeGitCommandHost,
    'getAgentSwitchBlocker' | 'recordBranchSwitched' | 'persistMaterializedPushTarget'
  >
}

type SourceControlCommandController =
  | RuntimeGitCommands
  | RuntimeGitHubRepositoryQueryCommands
  | RuntimeGitHubReviewQueryCommands
  | RuntimeGitHubReviewMutationCommands
  | RuntimeGitHubIssueCommentCommands
  | RuntimeHostedReviewCommands
  | RuntimeGitHubProjectCommands
  | RuntimeGitLabQueryCommands
  | RuntimeGitLabMutationCommands

type CommandOwner = {
  commands: SourceControlCommandController
  mutates: (method: string) => boolean
}

function dispatchProperty<T extends SourceControlCommandController | OrcaRuntimeService>(
  source: T,
  key: PropertyKey
): unknown {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a missing dynamic property returns undefined; every result stays unknown until the caller checks it before invocation.
  return source[key as keyof T]
}

export function createLocalSourceControlRuntime({
  runtime,
  store,
  repos,
  worktrees,
  getSignal,
  onMutation,
  gitHost
}: LocalSourceControlRuntimeOptions): OrcaRuntimeService {
  const targets = createLocalSourceControlTargets(repos, worktrees, getSignal)
  const getLocalGitArgs = (): [
    LocalProjectGhExecOptions & { hostGit: true; signal?: AbortSignal }
  ] => [{ hostGit: true, signal: getSignal?.() }]
  const forgeDeps = {
    resolveRepo: targets.resolveRepo,
    getLocalGitArgs
  }
  const owners: CommandOwner[] = [
    {
      commands: new RuntimeGitCommands({
        ...gitHost,
        resolveRuntimeGitTarget: targets.resolveRuntimeGitTarget,
        getRuntimeSettings: () => store.getSettings(),
        getWorktreeLinkedIssue: (id) =>
          worktrees.find((worktree) => worktree.id === id)?.linkedIssue,
        getWorktreeLinkedIssueMeta: (id) => worktrees.find((worktree) => worktree.id === id)
      }),
      mutates: (method) => gitMutationMethods.has(method)
    },
    {
      commands: new RuntimeGitHubRepositoryQueryCommands(forgeDeps),
      mutates: () => false
    },
    { commands: new RuntimeGitHubReviewQueryCommands(forgeDeps), mutates: () => false },
    { commands: new RuntimeGitHubReviewMutationCommands(forgeDeps), mutates: () => true },
    {
      commands: new RuntimeGitHubIssueCommentCommands({
        ...forgeDeps,
        resolveTarget: targets.resolveTarget
      }),
      mutates: () => true
    },
    {
      commands: new RuntimeHostedReviewCommands({
        resolveRepo: targets.resolveRepo,
        resolveTarget: targets.resolveTarget,
        getExecutionOptions: (_repo, admissionTier) => ({
          localGitExecOptions: { ...getLocalGitArgs()[0], admissionTier }
        }),
        recordCreated: () => {}
      }),
      mutates: (method) => method === 'createHostedReview' || method === 'createStackedHostedReview'
    },
    {
      commands: new RuntimeGitHubProjectCommands(),
      mutates: (method) => /^(update|clear|add|delete)/.test(method)
    },
    {
      commands: new RuntimeGitLabQueryCommands({ ...forgeDeps, recordProjectRecent: () => {} }),
      mutates: () => false
    },
    {
      commands: new RuntimeGitLabMutationCommands(forgeDeps),
      mutates: (method) => method !== 'getGitLabRepoJobTrace'
    }
  ]
  const boundMethods = new Map<PropertyKey, unknown>()
  return new Proxy(runtime, {
    get(target, property) {
      if (boundMethods.has(property)) {
        return boundMethods.get(property)
      }
      if (typeof property === 'string') {
        for (const owner of owners) {
          const command = dispatchProperty(owner.commands, property)
          if (typeof command !== 'function') {
            continue
          }
          const bound = async (...args: unknown[]): Promise<unknown> => {
            const result: unknown = await withAmbientGitHubAccount(() =>
              command.apply(owner.commands, args)
            )
            if (
              owner.mutates(property) &&
              !(result && typeof result === 'object' && 'success' in result && !result.success)
            ) {
              try {
                await onMutation?.()
              } catch (error) {
                console.warn('[local-git-execution] mutation refresh failed:', error)
              }
            }
            return result
          }
          boundMethods.set(property, bound)
          return bound
        }
      }
      const value = dispatchProperty(target, property)
      if (typeof value !== 'function') {
        return value
      }
      const bound = value.bind(target)
      boundMethods.set(property, bound)
      return bound
    }
  })
}
