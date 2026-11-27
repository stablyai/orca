import type {
  RuntimeGitLabQueryCommands,
  RuntimeGitLabQueryCommandsDeps
} from './runtime-gitlab-query-commands'
import type { RuntimeGitLabMutationCommands } from './runtime-gitlab-mutation-commands'
import type { Repo } from '../../../../shared/repository/repo-types'

type GitLabQuerySurface = Pick<
  RuntimeGitLabQueryCommands,
  Exclude<keyof RuntimeGitLabQueryCommands, 'constructor'>
>

type GitLabMutationSurface = Pick<
  RuntimeGitLabMutationCommands,
  Exclude<keyof RuntimeGitLabMutationCommands, 'constructor'>
>

type RuntimeGitLabMutationCommandsDeps = {
  resolveRepo: (selector: string) => Promise<Repo>
  getLocalGitArgs: (repo: Repo) => [] | [{ wslDistro?: string }]
}

export class LazyRuntimeGitLabQueryCommands implements GitLabQuerySurface {
  private instancePromise: Promise<RuntimeGitLabQueryCommands> | null = null

  constructor(private readonly deps: RuntimeGitLabQueryCommandsDeps) {}

  private load(): Promise<RuntimeGitLabQueryCommands> {
    return (this.instancePromise ??= import('./runtime-gitlab-query-commands')
      .then(({ RuntimeGitLabQueryCommands: Ctor }) => new Ctor(this.deps))
      .catch((error: unknown) => {
        // A transient import failure must not pin every later call to the same rejection.
        this.instancePromise = null
        throw error
      }))
  }

  listGitLabRepoWorkItems: GitLabQuerySurface['listGitLabRepoWorkItems'] = async (...args) =>
    (await this.load()).listGitLabRepoWorkItems(...args)

  listGitLabRepoMRs: GitLabQuerySurface['listGitLabRepoMRs'] = async (...args) =>
    (await this.load()).listGitLabRepoMRs(...args)

  listGitLabRepoIssues: GitLabQuerySurface['listGitLabRepoIssues'] = async (...args) =>
    (await this.load()).listGitLabRepoIssues(...args)

  listGitLabRepoTodos: GitLabQuerySurface['listGitLabRepoTodos'] = async (...args) =>
    (await this.load()).listGitLabRepoTodos(...args)

  diagnoseGitLabAuth: GitLabQuerySurface['diagnoseGitLabAuth'] = async () =>
    (await this.load()).diagnoseGitLabAuth()

  getGitLabRateLimit: GitLabQuerySurface['getGitLabRateLimit'] = async (...args) =>
    (await this.load()).getGitLabRateLimit(...args)

  listGitLabRepoLabels: GitLabQuerySurface['listGitLabRepoLabels'] = async (...args) =>
    (await this.load()).listGitLabRepoLabels(...args)

  listGitLabRepoAssignableUsers: GitLabQuerySurface['listGitLabRepoAssignableUsers'] = async (
    ...args
  ) => (await this.load()).listGitLabRepoAssignableUsers(...args)

  getGitLabRepoWorkItemDetails: GitLabQuerySurface['getGitLabRepoWorkItemDetails'] = async (
    ...args
  ) => (await this.load()).getGitLabRepoWorkItemDetails(...args)

  getGitLabRepoWorkItemByPath: GitLabQuerySurface['getGitLabRepoWorkItemByPath'] = async (
    ...args
  ) => (await this.load()).getGitLabRepoWorkItemByPath(...args)
}

export class LazyRuntimeGitLabMutationCommands implements GitLabMutationSurface {
  private instancePromise: Promise<RuntimeGitLabMutationCommands> | null = null

  constructor(private readonly deps: RuntimeGitLabMutationCommandsDeps) {}

  private load(): Promise<RuntimeGitLabMutationCommands> {
    return (this.instancePromise ??= import('./runtime-gitlab-mutation-commands')
      .then(({ RuntimeGitLabMutationCommands: Ctor }) => new Ctor(this.deps))
      .catch((error: unknown) => {
        // A transient import failure must not pin every later call to the same rejection.
        this.instancePromise = null
        throw error
      }))
  }

  createGitLabRepoIssue: GitLabMutationSurface['createGitLabRepoIssue'] = async (...args) =>
    (await this.load()).createGitLabRepoIssue(...args)

  updateGitLabRepoIssue: GitLabMutationSurface['updateGitLabRepoIssue'] = async (...args) =>
    (await this.load()).updateGitLabRepoIssue(...args)

  addGitLabRepoIssueComment: GitLabMutationSurface['addGitLabRepoIssueComment'] = async (...args) =>
    (await this.load()).addGitLabRepoIssueComment(...args)

  addGitLabRepoMRComment: GitLabMutationSurface['addGitLabRepoMRComment'] = async (...args) =>
    (await this.load()).addGitLabRepoMRComment(...args)

  addGitLabRepoMRInlineComment: GitLabMutationSurface['addGitLabRepoMRInlineComment'] = async (
    ...args
  ) => (await this.load()).addGitLabRepoMRInlineComment(...args)

  resolveGitLabRepoMRDiscussion: GitLabMutationSurface['resolveGitLabRepoMRDiscussion'] = async (
    ...args
  ) => (await this.load()).resolveGitLabRepoMRDiscussion(...args)

  getGitLabRepoJobTrace: GitLabMutationSurface['getGitLabRepoJobTrace'] = async (...args) =>
    (await this.load()).getGitLabRepoJobTrace(...args)

  retryGitLabRepoJob: GitLabMutationSurface['retryGitLabRepoJob'] = async (...args) =>
    (await this.load()).retryGitLabRepoJob(...args)

  mergeGitLabRepoMR: GitLabMutationSurface['mergeGitLabRepoMR'] = async (...args) =>
    (await this.load()).mergeGitLabRepoMR(...args)

  updateGitLabRepoMRState: GitLabMutationSurface['updateGitLabRepoMRState'] = async (...args) =>
    (await this.load()).updateGitLabRepoMRState(...args)

  updateGitLabRepoMR: GitLabMutationSurface['updateGitLabRepoMR'] = async (...args) =>
    (await this.load()).updateGitLabRepoMR(...args)

  updateGitLabRepoMRReviewers: GitLabMutationSurface['updateGitLabRepoMRReviewers'] = async (
    ...args
  ) => (await this.load()).updateGitLabRepoMRReviewers(...args)
}
