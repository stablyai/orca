import type { RuntimeGiteaCommands, RuntimeGiteaCommandsDeps } from './runtime-gitea-commands'

type GiteaSurface = Pick<RuntimeGiteaCommands, Exclude<keyof RuntimeGiteaCommands, 'constructor'>>

export class LazyRuntimeGiteaCommands implements GiteaSurface {
  private instancePromise: Promise<RuntimeGiteaCommands> | null = null

  constructor(private readonly deps: RuntimeGiteaCommandsDeps) {}

  private load(): Promise<RuntimeGiteaCommands> {
    return (this.instancePromise ??= import('./runtime-gitea-commands')
      .then(({ RuntimeGiteaCommands: Ctor }) => new Ctor(this.deps))
      .catch((error: unknown) => {
        // A transient import failure must not pin every later call to the same rejection.
        this.instancePromise = null
        throw error
      }))
  }

  listGiteaRepoWorkItems: GiteaSurface['listGiteaRepoWorkItems'] = async (...args) =>
    (await this.load()).listGiteaRepoWorkItems(...args)

  getGiteaRepoIssue: GiteaSurface['getGiteaRepoIssue'] = async (...args) =>
    (await this.load()).getGiteaRepoIssue(...args)

  listGiteaRepoIssueComments: GiteaSurface['listGiteaRepoIssueComments'] = async (...args) =>
    (await this.load()).listGiteaRepoIssueComments(...args)

  listGiteaRepoLabels: GiteaSurface['listGiteaRepoLabels'] = async (...args) =>
    (await this.load()).listGiteaRepoLabels(...args)

  listGiteaRepoAssignees: GiteaSurface['listGiteaRepoAssignees'] = async (...args) =>
    (await this.load()).listGiteaRepoAssignees(...args)

  createGiteaRepoIssue: GiteaSurface['createGiteaRepoIssue'] = async (...args) =>
    (await this.load()).createGiteaRepoIssue(...args)

  updateGiteaRepoIssue: GiteaSurface['updateGiteaRepoIssue'] = async (...args) =>
    (await this.load()).updateGiteaRepoIssue(...args)

  addGiteaRepoIssueComment: GiteaSurface['addGiteaRepoIssueComment'] = async (...args) =>
    (await this.load()).addGiteaRepoIssueComment(...args)

  getGiteaRepoPullRequestDetail: GiteaSurface['getGiteaRepoPullRequestDetail'] = async (...args) =>
    (await this.load()).getGiteaRepoPullRequestDetail(...args)

  listGiteaRepoPullRequestFiles: GiteaSurface['listGiteaRepoPullRequestFiles'] = async (...args) =>
    (await this.load()).listGiteaRepoPullRequestFiles(...args)

  getGiteaRepoPullRequestFileContents: GiteaSurface['getGiteaRepoPullRequestFileContents'] = async (
    ...args
  ) => (await this.load()).getGiteaRepoPullRequestFileContents(...args)

  getGiteaRepoPullRequestChecks: GiteaSurface['getGiteaRepoPullRequestChecks'] = async (...args) =>
    (await this.load()).getGiteaRepoPullRequestChecks(...args)

  mergeGiteaRepoPullRequest: GiteaSurface['mergeGiteaRepoPullRequest'] = async (...args) =>
    (await this.load()).mergeGiteaRepoPullRequest(...args)

  listGiteaRepoPullRequestReviewComments: GiteaSurface['listGiteaRepoPullRequestReviewComments'] =
    async (...args) => (await this.load()).listGiteaRepoPullRequestReviewComments(...args)

  addGiteaRepoPullRequestReviewComment: GiteaSurface['addGiteaRepoPullRequestReviewComment'] =
    async (...args) => (await this.load()).addGiteaRepoPullRequestReviewComment(...args)
}
