import type { RuntimeGitHubIssueCommentCommands } from './runtime-github-issue-comment-commands'
import type { RuntimeGitHubProjectCommands } from './runtime-github-project-commands'
import type { RuntimeGitHubReviewMutationCommands } from './runtime-github-review-mutation-commands'
import type { RuntimeGitHubReviewQueryCommands } from './runtime-github-review-query-commands'
import type { RuntimeGitLabMutationCommands } from './runtime-gitlab-mutation-commands'
import type { RuntimeGitLabQueryCommands } from './runtime-gitlab-query-commands'

type GitLabQueryName = Exclude<keyof RuntimeGitLabQueryCommands, 'constructor'>
type GitLabMutationName = Exclude<keyof RuntimeGitLabMutationCommands, 'constructor'>
type GitHubProjectName = Exclude<keyof RuntimeGitHubProjectCommands, 'constructor'>
type GitHubReviewQueryName =
  | 'getRepoIssue'
  | 'getRepoPRChecks'
  | 'getRepoPRCheckDetails'
  | 'getRepoPRComments'
  | 'getRepoPRFileContents'
type GitHubReviewMutationName =
  | 'rerunRepoPRChecks'
  | 'setRepoPRCommentReaction'
  | 'resolveRepoReviewThread'
  | 'setRepoPRFileViewed'
  | 'updateRepoPRTitle'
  | 'updateRepoPRDetails'
  | 'mergeRepoPR'
  | 'setRepoPRAutoMerge'
  | 'markRepoPRReadyForReview'
  | 'updateRepoPRState'
  | 'requestRepoPRReviewers'
  | 'removeRepoPRReviewers'
type GitHubIssueCommentName =
  | 'createRepoIssue'
  | 'updateRepoIssue'
  | 'addRepoIssueComment'
  | 'addRepoPRReviewComment'
  | 'addRepoPRReviewCommentReply'

export type RuntimeReviewCommandSurface = {} & Pick<RuntimeGitLabQueryCommands, GitLabQueryName> &
  Pick<RuntimeGitLabMutationCommands, GitLabMutationName> &
  Pick<RuntimeGitHubReviewQueryCommands, GitHubReviewQueryName> &
  Pick<RuntimeGitHubReviewMutationCommands, GitHubReviewMutationName> &
  Pick<RuntimeGitHubIssueCommentCommands, GitHubIssueCommentName> &
  Pick<RuntimeGitHubProjectCommands, GitHubProjectName>

type RuntimeReviewCommandOwners = {
  gitLabQueries: RuntimeGitLabQueryCommands
  gitLabMutations: RuntimeGitLabMutationCommands
  gitHubReviewQueries: RuntimeGitHubReviewQueryCommands
  gitHubReviewMutations: RuntimeGitHubReviewMutationCommands
  gitHubIssueComments: RuntimeGitHubIssueCommentCommands
  gitHubProjects: RuntimeGitHubProjectCommands
}

export function installRuntimeReviewCommandSurface(
  target: RuntimeReviewCommandSurface,
  owners: RuntimeReviewCommandOwners
): void {
  const glq = owners.gitLabQueries
  const glm = owners.gitLabMutations
  const ghq = owners.gitHubReviewQueries
  const ghm = owners.gitHubReviewMutations
  const comments = owners.gitHubIssueComments
  const projects = owners.gitHubProjects
  Object.assign(target, {
    listGitLabRepoWorkItems: glq.listGitLabRepoWorkItems.bind(glq),
    listGitLabRepoMRs: glq.listGitLabRepoMRs.bind(glq),
    listGitLabRepoIssues: glq.listGitLabRepoIssues.bind(glq),
    listGitLabRepoTodos: glq.listGitLabRepoTodos.bind(glq),
    diagnoseGitLabAuth: glq.diagnoseGitLabAuth.bind(glq),
    getGitLabRateLimit: glq.getGitLabRateLimit.bind(glq),
    listGitLabRepoLabels: glq.listGitLabRepoLabels.bind(glq),
    getGitLabRepoWorkItemDetails: glq.getGitLabRepoWorkItemDetails.bind(glq),
    getGitLabRepoWorkItemByPath: glq.getGitLabRepoWorkItemByPath.bind(glq),
    createGitLabRepoIssue: glm.createGitLabRepoIssue.bind(glm),
    updateGitLabRepoIssue: glm.updateGitLabRepoIssue.bind(glm),
    addGitLabRepoIssueComment: glm.addGitLabRepoIssueComment.bind(glm),
    addGitLabRepoMRComment: glm.addGitLabRepoMRComment.bind(glm),
    addGitLabRepoMRInlineComment: glm.addGitLabRepoMRInlineComment.bind(glm),
    resolveGitLabRepoMRDiscussion: glm.resolveGitLabRepoMRDiscussion.bind(glm),
    getGitLabRepoJobTrace: glm.getGitLabRepoJobTrace.bind(glm),
    retryGitLabRepoJob: glm.retryGitLabRepoJob.bind(glm),
    mergeGitLabRepoMR: glm.mergeGitLabRepoMR.bind(glm),
    updateGitLabRepoMRState: glm.updateGitLabRepoMRState.bind(glm),
    updateGitLabRepoMR: glm.updateGitLabRepoMR.bind(glm),
    updateGitLabRepoMRReviewers: glm.updateGitLabRepoMRReviewers.bind(glm),
    getRepoIssue: ghq.getRepoIssue.bind(ghq),
    getRepoPRChecks: ghq.getRepoPRChecks.bind(ghq),
    getRepoPRCheckDetails: ghq.getRepoPRCheckDetails.bind(ghq),
    getRepoPRComments: ghq.getRepoPRComments.bind(ghq),
    getRepoPRFileContents: ghq.getRepoPRFileContents.bind(ghq),
    rerunRepoPRChecks: ghm.rerunRepoPRChecks.bind(ghm),
    setRepoPRCommentReaction: ghm.setRepoPRCommentReaction.bind(ghm),
    resolveRepoReviewThread: ghm.resolveRepoReviewThread.bind(ghm),
    setRepoPRFileViewed: ghm.setRepoPRFileViewed.bind(ghm),
    updateRepoPRTitle: ghm.updateRepoPRTitle.bind(ghm),
    updateRepoPRDetails: ghm.updateRepoPRDetails.bind(ghm),
    mergeRepoPR: ghm.mergeRepoPR.bind(ghm),
    setRepoPRAutoMerge: ghm.setRepoPRAutoMerge.bind(ghm),
    markRepoPRReadyForReview: ghm.markRepoPRReadyForReview.bind(ghm),
    updateRepoPRState: ghm.updateRepoPRState.bind(ghm),
    requestRepoPRReviewers: ghm.requestRepoPRReviewers.bind(ghm),
    removeRepoPRReviewers: ghm.removeRepoPRReviewers.bind(ghm),
    createRepoIssue: comments.createRepoIssue.bind(comments),
    updateRepoIssue: comments.updateRepoIssue.bind(comments),
    addRepoIssueComment: comments.addRepoIssueComment.bind(comments),
    addRepoPRReviewComment: comments.addRepoPRReviewComment.bind(comments),
    addRepoPRReviewCommentReply: comments.addRepoPRReviewCommentReply.bind(comments),
    listGitHubProjects: projects.listGitHubProjects.bind(projects),
    listGitHubLabelsBySlug: projects.listGitHubLabelsBySlug.bind(projects),
    listGitHubAssignableUsersBySlug: projects.listGitHubAssignableUsersBySlug.bind(projects),
    listGitHubIssueTypesBySlug: projects.listGitHubIssueTypesBySlug.bind(projects),
    resolveGitHubProjectRef: projects.resolveGitHubProjectRef.bind(projects),
    listGitHubProjectViews: projects.listGitHubProjectViews.bind(projects),
    getGitHubProjectViewTable: projects.getGitHubProjectViewTable.bind(projects),
    getGitHubProjectWorkItemDetailsBySlug:
      projects.getGitHubProjectWorkItemDetailsBySlug.bind(projects),
    updateGitHubProjectItemField: projects.updateGitHubProjectItemField.bind(projects),
    clearGitHubProjectItemField: projects.clearGitHubProjectItemField.bind(projects),
    updateGitHubIssueBySlug: projects.updateGitHubIssueBySlug.bind(projects),
    updateGitHubPullRequestBySlug: projects.updateGitHubPullRequestBySlug.bind(projects),
    updateGitHubIssueTypeBySlug: projects.updateGitHubIssueTypeBySlug.bind(projects),
    addGitHubIssueCommentBySlug: projects.addGitHubIssueCommentBySlug.bind(projects),
    updateGitHubIssueCommentBySlug: projects.updateGitHubIssueCommentBySlug.bind(projects),
    deleteGitHubIssueCommentBySlug: projects.deleteGitHubIssueCommentBySlug.bind(projects)
  })
}
