import type { RuntimeGitHubReviewQueryCommands } from './runtime-github-review-query-commands'
import type { RuntimeGitHubReviewMutationCommands } from './runtime-github-review-mutation-commands'
import type { RuntimeGitHubIssueCommentCommands } from './runtime-github-issue-comment-commands'
import type { RuntimeGitHubProjectCommands } from './runtime-github-project-commands'

type ReviewQuerySurface = Pick<
  RuntimeGitHubReviewQueryCommands,
  Exclude<keyof RuntimeGitHubReviewQueryCommands, 'constructor'>
>
type ReviewMutationSurface = Pick<
  RuntimeGitHubReviewMutationCommands,
  Exclude<keyof RuntimeGitHubReviewMutationCommands, 'constructor'>
>
type IssueCommentSurface = Pick<
  RuntimeGitHubIssueCommentCommands,
  Exclude<keyof RuntimeGitHubIssueCommentCommands, 'constructor'>
>
type ProjectSurface = Pick<
  RuntimeGitHubProjectCommands,
  Exclude<keyof RuntimeGitHubProjectCommands, 'constructor'>
>

export class LazyRuntimeGitHubReviewQueryCommands implements ReviewQuerySurface {
  private instancePromise: Promise<RuntimeGitHubReviewQueryCommands> | null = null

  constructor(
    private readonly deps: ConstructorParameters<typeof RuntimeGitHubReviewQueryCommands>[0]
  ) {}

  private load(): Promise<RuntimeGitHubReviewQueryCommands> {
    return (this.instancePromise ??= import('./runtime-github-review-query-commands')
      .then(({ RuntimeGitHubReviewQueryCommands: Ctor }) => new Ctor(this.deps))
      .catch((error: unknown) => {
        this.instancePromise = null
        throw error
      }))
  }

  getRepoIssue: ReviewQuerySurface['getRepoIssue'] = async (...args) =>
    (await this.load()).getRepoIssue(...args)

  getRepoPRChecks: ReviewQuerySurface['getRepoPRChecks'] = async (...args) =>
    (await this.load()).getRepoPRChecks(...args)

  getRepoPRCheckDetails: ReviewQuerySurface['getRepoPRCheckDetails'] = async (...args) =>
    (await this.load()).getRepoPRCheckDetails(...args)

  getRepoPRComments: ReviewQuerySurface['getRepoPRComments'] = async (...args) =>
    (await this.load()).getRepoPRComments(...args)

  getRepoPRFileContents: ReviewQuerySurface['getRepoPRFileContents'] = async (...args) =>
    (await this.load()).getRepoPRFileContents(...args)
}

export class LazyRuntimeGitHubReviewMutationCommands implements ReviewMutationSurface {
  private instancePromise: Promise<RuntimeGitHubReviewMutationCommands> | null = null

  constructor(
    private readonly deps: ConstructorParameters<typeof RuntimeGitHubReviewMutationCommands>[0]
  ) {}

  private load(): Promise<RuntimeGitHubReviewMutationCommands> {
    return (this.instancePromise ??= import('./runtime-github-review-mutation-commands')
      .then(({ RuntimeGitHubReviewMutationCommands: Ctor }) => new Ctor(this.deps))
      .catch((error: unknown) => {
        this.instancePromise = null
        throw error
      }))
  }

  rerunRepoPRChecks: ReviewMutationSurface['rerunRepoPRChecks'] = async (...args) =>
    (await this.load()).rerunRepoPRChecks(...args)

  setRepoPRCommentReaction: ReviewMutationSurface['setRepoPRCommentReaction'] = async (...args) =>
    (await this.load()).setRepoPRCommentReaction(...args)

  resolveRepoReviewThread: ReviewMutationSurface['resolveRepoReviewThread'] = async (...args) =>
    (await this.load()).resolveRepoReviewThread(...args)

  setRepoPRFileViewed: ReviewMutationSurface['setRepoPRFileViewed'] = async (...args) =>
    (await this.load()).setRepoPRFileViewed(...args)

  updateRepoPRTitle: ReviewMutationSurface['updateRepoPRTitle'] = async (...args) =>
    (await this.load()).updateRepoPRTitle(...args)

  updateRepoPRDetails: ReviewMutationSurface['updateRepoPRDetails'] = async (...args) =>
    (await this.load()).updateRepoPRDetails(...args)

  mergeRepoPR: ReviewMutationSurface['mergeRepoPR'] = async (...args) =>
    (await this.load()).mergeRepoPR(...args)

  setRepoPRAutoMerge: ReviewMutationSurface['setRepoPRAutoMerge'] = async (...args) =>
    (await this.load()).setRepoPRAutoMerge(...args)

  markRepoPRReadyForReview: ReviewMutationSurface['markRepoPRReadyForReview'] = async (...args) =>
    (await this.load()).markRepoPRReadyForReview(...args)

  markRepoPRDraft: ReviewMutationSurface['markRepoPRDraft'] = async (...args) =>
    (await this.load()).markRepoPRDraft(...args)

  updateRepoPRState: ReviewMutationSurface['updateRepoPRState'] = async (...args) =>
    (await this.load()).updateRepoPRState(...args)

  requestRepoPRReviewers: ReviewMutationSurface['requestRepoPRReviewers'] = async (...args) =>
    (await this.load()).requestRepoPRReviewers(...args)

  removeRepoPRReviewers: ReviewMutationSurface['removeRepoPRReviewers'] = async (...args) =>
    (await this.load()).removeRepoPRReviewers(...args)
}

export class LazyRuntimeGitHubIssueCommentCommands implements IssueCommentSurface {
  private instancePromise: Promise<RuntimeGitHubIssueCommentCommands> | null = null

  constructor(
    private readonly deps: ConstructorParameters<typeof RuntimeGitHubIssueCommentCommands>[0]
  ) {}

  private load(): Promise<RuntimeGitHubIssueCommentCommands> {
    return (this.instancePromise ??= import('./runtime-github-issue-comment-commands')
      .then(({ RuntimeGitHubIssueCommentCommands: Ctor }) => new Ctor(this.deps))
      .catch((error: unknown) => {
        this.instancePromise = null
        throw error
      }))
  }

  createRepoIssue: IssueCommentSurface['createRepoIssue'] = async (...args) =>
    (await this.load()).createRepoIssue(...args)

  uploadGitHubAttachment: IssueCommentSurface['uploadGitHubAttachment'] = async (...args) =>
    (await this.load()).uploadGitHubAttachment(...args)

  updateRepoIssue: IssueCommentSurface['updateRepoIssue'] = async (...args) =>
    (await this.load()).updateRepoIssue(...args)

  addRepoIssueComment: IssueCommentSurface['addRepoIssueComment'] = async (...args) =>
    (await this.load()).addRepoIssueComment(...args)

  addRepoPRReviewComment: IssueCommentSurface['addRepoPRReviewComment'] = async (...args) =>
    (await this.load()).addRepoPRReviewComment(...args)

  addRepoPRReviewCommentReply: IssueCommentSurface['addRepoPRReviewCommentReply'] = async (
    ...args
  ) => (await this.load()).addRepoPRReviewCommentReply(...args)
}

export class LazyRuntimeGitHubProjectCommands implements ProjectSurface {
  private instancePromise: Promise<RuntimeGitHubProjectCommands> | null = null

  private load(): Promise<RuntimeGitHubProjectCommands> {
    return (this.instancePromise ??= import('./runtime-github-project-commands')
      .then(({ RuntimeGitHubProjectCommands: Ctor }) => new Ctor())
      .catch((error: unknown) => {
        this.instancePromise = null
        throw error
      }))
  }

  listGitHubProjects: ProjectSurface['listGitHubProjects'] = async (...args) =>
    (await this.load()).listGitHubProjects(...args)

  listGitHubLabelsBySlug: ProjectSurface['listGitHubLabelsBySlug'] = async (...args) =>
    (await this.load()).listGitHubLabelsBySlug(...args)

  listGitHubAssignableUsersBySlug: ProjectSurface['listGitHubAssignableUsersBySlug'] = async (
    ...args
  ) => (await this.load()).listGitHubAssignableUsersBySlug(...args)

  listGitHubIssueTypesBySlug: ProjectSurface['listGitHubIssueTypesBySlug'] = async (...args) =>
    (await this.load()).listGitHubIssueTypesBySlug(...args)

  resolveGitHubProjectRef: ProjectSurface['resolveGitHubProjectRef'] = async (...args) =>
    (await this.load()).resolveGitHubProjectRef(...args)

  listGitHubProjectViews: ProjectSurface['listGitHubProjectViews'] = async (...args) =>
    (await this.load()).listGitHubProjectViews(...args)

  getGitHubProjectViewTable: ProjectSurface['getGitHubProjectViewTable'] = async (...args) =>
    (await this.load()).getGitHubProjectViewTable(...args)

  getGitHubProjectWorkItemDetailsBySlug: ProjectSurface['getGitHubProjectWorkItemDetailsBySlug'] =
    async (...args) => (await this.load()).getGitHubProjectWorkItemDetailsBySlug(...args)

  updateGitHubProjectItemField: ProjectSurface['updateGitHubProjectItemField'] = async (...args) =>
    (await this.load()).updateGitHubProjectItemField(...args)

  clearGitHubProjectItemField: ProjectSurface['clearGitHubProjectItemField'] = async (...args) =>
    (await this.load()).clearGitHubProjectItemField(...args)

  updateGitHubIssueBySlug: ProjectSurface['updateGitHubIssueBySlug'] = async (...args) =>
    (await this.load()).updateGitHubIssueBySlug(...args)

  updateGitHubPullRequestBySlug: ProjectSurface['updateGitHubPullRequestBySlug'] = async (
    ...args
  ) => (await this.load()).updateGitHubPullRequestBySlug(...args)

  updateGitHubIssueTypeBySlug: ProjectSurface['updateGitHubIssueTypeBySlug'] = async (...args) =>
    (await this.load()).updateGitHubIssueTypeBySlug(...args)

  addGitHubIssueCommentBySlug: ProjectSurface['addGitHubIssueCommentBySlug'] = async (...args) =>
    (await this.load()).addGitHubIssueCommentBySlug(...args)

  updateGitHubIssueCommentBySlug: ProjectSurface['updateGitHubIssueCommentBySlug'] = async (
    ...args
  ) => (await this.load()).updateGitHubIssueCommentBySlug(...args)

  deleteGitHubIssueCommentBySlug: ProjectSurface['deleteGitHubIssueCommentBySlug'] = async (
    ...args
  ) => (await this.load()).deleteGitHubIssueCommentBySlug(...args)
}
