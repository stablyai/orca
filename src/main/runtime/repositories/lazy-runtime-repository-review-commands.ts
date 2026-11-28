import type { Repo } from '../../../shared/repository/repo-types'
import type { OrcaHooks } from '../../../shared/workspace-setup/orca-yaml-hook-types'
import type { WorkspaceHookOwner } from '../../../shared/workspace-setup/hooks/workspace-hook-owner'
import type { SetupHooksCreateSource } from '../../../shared/worktree/setup-hooks-create-source'
import type { RuntimeHostedReviewCommands } from '../integrations/reviews/runtime-hosted-review-commands'
import type { RuntimeGitHubRepositoryQueryCommands } from '../integrations/github/runtime-github-repository-query-commands'
import type { RuntimeRepositoryHooksCommands } from './runtime-repository-hooks-commands'
import type { RuntimeRepositoryIssueCommand } from './runtime-repository-issue-command'

export type HostedReviewCommandName =
  | 'getRepoSlug'
  | 'getRepoUpstream'
  | 'getRepoPRForBranch'
  | 'getHostedReviewForBranch'
  | 'getHostedReviewCreationEligibility'
  | 'createHostedReview'
  | 'createStackedHostedReview'

export type GitHubRepositoryQueryCommandName =
  | 'listRepoWorkItems'
  | 'listRepoIssues'
  | 'getRepoWorkItem'
  | 'getRepoWorkItemByOwnerRepo'
  | 'getRepoWorkItemDetails'
  | 'countRepoWorkItems'
  | 'getRepoIssueSource'
  | 'listRepoLabels'
  | 'listRepoAssignableUsers'
  | 'getGitHubRateLimit'
  | 'listGitHubBindableAccounts'
  | 'validateGitHubAccountBinding'

export type RuntimeHostedReviewSurface = Pick<RuntimeHostedReviewCommands, HostedReviewCommandName>
export type RuntimeGitHubRepositoryQuerySurface = Pick<
  RuntimeGitHubRepositoryQueryCommands,
  GitHubRepositoryQueryCommandName
>
export type RuntimeRepositoryHooksSurface = Pick<
  RuntimeRepositoryHooksCommands,
  'getRepoHooks' | 'checkRepoHooks' | 'inspectRepoSetupScriptImports'
>
export type RuntimeRepositoryIssueCommandSurface = Pick<
  RuntimeRepositoryIssueCommand,
  'read' | 'write'
>

export class LazyRuntimeHostedReviewCommands implements RuntimeHostedReviewSurface {
  private instancePromise: Promise<RuntimeHostedReviewCommands> | null = null

  constructor(
    private readonly deps: ConstructorParameters<typeof RuntimeHostedReviewCommands>[0]
  ) {}

  private load(): Promise<RuntimeHostedReviewCommands> {
    return (this.instancePromise ??=
      import('../integrations/reviews/runtime-hosted-review-commands')
        .then(({ RuntimeHostedReviewCommands: Ctor }) => new Ctor(this.deps))
        .catch((error: unknown) => {
          this.instancePromise = null
          throw error
        }))
  }

  getRepoSlug: RuntimeHostedReviewSurface['getRepoSlug'] = async (...args) =>
    (await this.load()).getRepoSlug(...args)

  getRepoUpstream: RuntimeHostedReviewSurface['getRepoUpstream'] = async (...args) =>
    (await this.load()).getRepoUpstream(...args)

  getRepoPRForBranch: RuntimeHostedReviewSurface['getRepoPRForBranch'] = async (...args) =>
    (await this.load()).getRepoPRForBranch(...args)

  getHostedReviewForBranch: RuntimeHostedReviewSurface['getHostedReviewForBranch'] = async (
    ...args
  ) => (await this.load()).getHostedReviewForBranch(...args)

  getHostedReviewCreationEligibility: RuntimeHostedReviewSurface['getHostedReviewCreationEligibility'] =
    async (...args) => (await this.load()).getHostedReviewCreationEligibility(...args)

  createHostedReview: RuntimeHostedReviewSurface['createHostedReview'] = async (...args) =>
    (await this.load()).createHostedReview(...args)

  createStackedHostedReview: RuntimeHostedReviewSurface['createStackedHostedReview'] = async (
    ...args
  ) => (await this.load()).createStackedHostedReview(...args)
}

export class LazyRuntimeGitHubRepositoryQueryCommands implements RuntimeGitHubRepositoryQuerySurface {
  private instancePromise: Promise<RuntimeGitHubRepositoryQueryCommands> | null = null

  constructor(
    private readonly deps: ConstructorParameters<typeof RuntimeGitHubRepositoryQueryCommands>[0]
  ) {}

  private load(): Promise<RuntimeGitHubRepositoryQueryCommands> {
    return (this.instancePromise ??=
      import('../integrations/github/runtime-github-repository-query-commands')
        .then(({ RuntimeGitHubRepositoryQueryCommands: Ctor }) => new Ctor(this.deps))
        .catch((error: unknown) => {
          this.instancePromise = null
          throw error
        }))
  }

  listRepoWorkItems: RuntimeGitHubRepositoryQuerySurface['listRepoWorkItems'] = async (...args) =>
    (await this.load()).listRepoWorkItems(...args)

  listRepoIssues: RuntimeGitHubRepositoryQuerySurface['listRepoIssues'] = async (...args) =>
    (await this.load()).listRepoIssues(...args)

  getRepoWorkItem: RuntimeGitHubRepositoryQuerySurface['getRepoWorkItem'] = async (...args) =>
    (await this.load()).getRepoWorkItem(...args)

  getRepoWorkItemByOwnerRepo: RuntimeGitHubRepositoryQuerySurface['getRepoWorkItemByOwnerRepo'] =
    async (...args) => (await this.load()).getRepoWorkItemByOwnerRepo(...args)

  getRepoWorkItemDetails: RuntimeGitHubRepositoryQuerySurface['getRepoWorkItemDetails'] = async (
    ...args
  ) => (await this.load()).getRepoWorkItemDetails(...args)

  countRepoWorkItems: RuntimeGitHubRepositoryQuerySurface['countRepoWorkItems'] = async (...args) =>
    (await this.load()).countRepoWorkItems(...args)

  getRepoIssueSource: RuntimeGitHubRepositoryQuerySurface['getRepoIssueSource'] = async (...args) =>
    (await this.load()).getRepoIssueSource(...args)

  listRepoLabels: RuntimeGitHubRepositoryQuerySurface['listRepoLabels'] = async (...args) =>
    (await this.load()).listRepoLabels(...args)

  listRepoAssignableUsers: RuntimeGitHubRepositoryQuerySurface['listRepoAssignableUsers'] = async (
    ...args
  ) => (await this.load()).listRepoAssignableUsers(...args)

  getGitHubRateLimit: RuntimeGitHubRepositoryQuerySurface['getGitHubRateLimit'] = async (...args) =>
    (await this.load()).getGitHubRateLimit(...args)

  listGitHubBindableAccounts: RuntimeGitHubRepositoryQuerySurface['listGitHubBindableAccounts'] =
    async (...args) => (await this.load()).listGitHubBindableAccounts(...args)

  validateGitHubAccountBinding: RuntimeGitHubRepositoryQuerySurface['validateGitHubAccountBinding'] =
    async (...args) => (await this.load()).validateGitHubAccountBinding(...args)
}

type LazyRepositoryHooksCommandsDeps<TRepo extends WorkspaceHookOwner> = {
  resolveRepo: (selector: string) => Promise<TRepo>
  resolveProjectGroupOwner?: (groupId: string) => WorkspaceHookOwner | null
  readCreateSourceHooks: (
    repo: TRepo,
    source: SetupHooksCreateSource
  ) => Promise<{ hooks: OrcaHooks | null } | undefined>
}

export class LazyRuntimeRepositoryHooksCommands<
  TRepo extends WorkspaceHookOwner = Repo
> implements RuntimeRepositoryHooksSurface {
  private instancePromise: Promise<RuntimeRepositoryHooksCommands<TRepo>> | null = null

  constructor(private readonly deps: LazyRepositoryHooksCommandsDeps<TRepo>) {}

  private load(): Promise<RuntimeRepositoryHooksCommands<TRepo>> {
    return (this.instancePromise ??= import('./runtime-repository-hooks-commands')
      .then(({ RuntimeRepositoryHooksCommands: Ctor }) => new Ctor<TRepo>(this.deps))
      .catch((error: unknown) => {
        this.instancePromise = null
        throw error
      }))
  }

  getRepoHooks: RuntimeRepositoryHooksSurface['getRepoHooks'] = async (...args) =>
    (await this.load()).getRepoHooks(...args)

  checkRepoHooks: RuntimeRepositoryHooksSurface['checkRepoHooks'] = async (...args) =>
    (await this.load()).checkRepoHooks(...args)

  inspectRepoSetupScriptImports: RuntimeRepositoryHooksSurface['inspectRepoSetupScriptImports'] =
    async (...args) => (await this.load()).inspectRepoSetupScriptImports(...args)
}

export class LazyRuntimeRepositoryIssueCommand implements RuntimeRepositoryIssueCommandSurface {
  private instancePromise: Promise<RuntimeRepositoryIssueCommand> | null = null

  constructor(
    private readonly deps: ConstructorParameters<typeof RuntimeRepositoryIssueCommand>[0]
  ) {}

  private load(): Promise<RuntimeRepositoryIssueCommand> {
    return (this.instancePromise ??= import('./runtime-repository-issue-command')
      .then(({ RuntimeRepositoryIssueCommand: Ctor }) => new Ctor(this.deps))
      .catch((error: unknown) => {
        this.instancePromise = null
        throw error
      }))
  }

  read: RuntimeRepositoryIssueCommandSurface['read'] = async (...args) =>
    (await this.load()).read(...args)

  write: RuntimeRepositoryIssueCommandSurface['write'] = async (...args) =>
    (await this.load()).write(...args)
}
