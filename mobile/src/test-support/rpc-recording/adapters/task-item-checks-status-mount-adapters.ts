import { hookMount, performHookAction } from '../hook-mount'
import { observableModel, projectObservable } from '../observable-model'
import type { MountAdapter, MountContext, MountedOperation } from '../recording-scenario'
import type { operationModuleLoader } from '../operation-module-loader'
import { mountFixture } from '../recorder-fixture-shape'

const REPO_ID = 'repo-1'

/** A PR review comment: has a path, a numeric line and a numeric id, so a reply is a review reply. */
const REVIEW_COMMENT = {
  id: 501,
  author: 'octocat',
  body: 'please fix',
  createdAt: '2020-01-01T00:00:00.000Z',
  path: 'src/index.ts',
  line: 12,
  threadId: 'thread-1',
  isResolved: false
} as const

/** An issue comment: no path or line, so a reply falls back to a plain issue comment. */
const ISSUE_COMMENT = {
  id: 'comment-2',
  author: 'octocat',
  body: 'a thought',
  createdAt: '2020-01-01T00:00:00.000Z'
} as const

const DETAIL_FILE = {
  path: 'src/index.ts',
  oldPath: undefined,
  status: 'modified',
  additions: 2,
  deletions: 1,
  viewerViewedState: 'UNVIEWED'
} as const

function githubDetailPayload(): Record<string, unknown> {
  return {
    provider: 'github',
    body: 'body',
    comments: [REVIEW_COMMENT, ISSUE_COMMENT],
    labels: ['bug'],
    assignees: ['octocat'],
    reviewDecision: null,
    reviewRequests: [],
    latestReviews: [],
    headSha: 'head-sha',
    baseSha: 'base-sha',
    pullRequestId: 'PR_kwDO',
    checks: [],
    files: [DETAIL_FILE]
  }
}

const GITHUB_PR_ITEM = {
  provider: 'github',
  title: 'A pull request',
  source: {
    id: 'github:pr:12',
    repoId: REPO_ID,
    number: 12,
    type: 'pr',
    state: 'open',
    labels: ['bug'],
    reviewRequests: [],
    latestReviews: [],
    reviewDecision: null
  }
} as const

const GITHUB_ISSUE_ITEM = {
  provider: 'github',
  title: 'An issue',
  source: {
    id: 'github:issue:9',
    repoId: REPO_ID,
    number: 9,
    type: 'issue',
    state: 'open',
    labels: ['bug'],
    reviewRequests: []
  }
} as const

const GITLAB_ISSUE_ITEM = {
  provider: 'gitlab',
  title: 'A GitLab issue',
  source: {
    id: 'gitlab:issue:4',
    repoId: REPO_ID,
    number: 4,
    type: 'issue',
    state: 'opened',
    labels: ['bug'],
    projectRef: 'group/project'
  }
} as const

const GITLAB_MR_ITEM = {
  provider: 'gitlab',
  title: 'A merge request',
  source: {
    id: 'gitlab:mr:7',
    repoId: REPO_ID,
    number: 7,
    type: 'mr',
    state: 'opened',
    labels: [],
    projectRef: 'group/project'
  }
} as const

function gitlabDetailPayload(): Record<string, unknown> {
  return {
    provider: 'gitlab',
    body: 'body',
    comments: [ISSUE_COMMENT],
    labels: ['bug'],
    assignees: [],
    pipelineJobs: []
  }
}

/**
 * One model in, an actions object out, every setter recorded as an effect: the shape this domain's
 * hooks share. Copied per module rather than shared, because an adapter may not import another file
 * in this directory: a golden pins the one module it was recorded through, so plumbing reaching
 * across the seam would drive recordings its header does not cover.
 */
type ModelHookSpec<Actions> = {
  /** Called inside the render body, so a hook that throws is recorded as a mount failure. */
  readonly useHook: (model: never) => Actions
  readonly fixture: Record<string, unknown>
  readonly actions: (context: {
    /** A getter, not a value: an action that re-renders first needs the rebuilt callbacks. */
    readonly actions: () => Actions
    readonly model: Record<string, unknown>
    readonly update: () => void
  }) => Record<string, (args: Record<string, unknown>) => unknown>
  readonly state: (model: Record<string, unknown>) => Record<string, unknown>
}

function mountModelHook<Actions>(
  context: MountContext,
  spec: ModelHookSpec<Actions>
): MountedOperation {
  const model = observableModel(context, { client: context.client, ...spec.fixture })
  let actions!: Actions
  const hook = hookMount(() => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the recorder supplies every member the hook reads.
    actions = spec.useHook(model as unknown as never)
  })
  return {
    action(name, args) {
      if (name === 'mount') {
        return hook.mount()
      }
      if (name === 'update') {
        return hook.update()
      }
      const step = spec.actions({
        actions: () => actions,
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the proxy is the fixture record the spec declared.
        model: model as unknown as Record<string, unknown>,
        update: hook.update
      })[name]
      if (!step) {
        throw new Error(`Unknown action: ${name}`)
      }
      return performHookAction(() => step(args))
    },
    state: () => projectObservable(spec.state(model)),
    dispose: hook.unmount
  }
}

/**
 * A pull request's checks and file list, and the open-or-closed state a hosted item can be moved
 * to. Both read a detail payload the screen already holds rather than re-fetching it.
 */
export function taskItemChecksStatusMountAdapters(
  modules: ReturnType<typeof operationModuleLoader>
): Record<string, MountAdapter> {
  const load = <T>(file: string): T => modules.load<T>(`mobile/src/tasks/${file}`)
  const checkFiles: MountAdapter = (context) => {
    const useActions = load<
      typeof import('../../../tasks/use-mobile-tasks-github-check-file-actions')
    >('use-mobile-tasks-github-check-file-actions.tsx').useMobileTasksGithubCheckFileActions
    return mountModelHook(context, {
      useHook: (model) => useActions(model),
      fixture: {
        detailPayload: githubDetailPayload(),
        expandedPrFilePath: null,
        mutatingStatus: false,
        prFileCommentDrafts: { 'src/index.ts:12': 'a review comment' },
        prFileContents: {},
        detailRefreshSeq: 0,
        error: ''
      },
      actions: ({ actions }) => ({
        rerun: () => actions().rerunGitHubChecks(mountFixture(GITHUB_PR_ITEM), true),
        viewed: () =>
          actions().toggleGitHubFileViewed(mountFixture(GITHUB_PR_ITEM), mountFixture(DETAIL_FILE)),
        thread: () =>
          actions().toggleGitHubReviewThread(
            mountFixture(GITHUB_PR_ITEM),
            mountFixture(REVIEW_COMMENT)
          ),
        expand: () =>
          actions().toggleGitHubFileExpansion(
            mountFixture(GITHUB_PR_ITEM),
            mountFixture(DETAIL_FILE)
          ),
        'file-comment': () =>
          actions().addGitHubFileReviewComment(
            mountFixture(GITHUB_PR_ITEM),
            mountFixture(DETAIL_FILE),
            12
          )
      }),
      state: (model) => ({
        payload: model.detailPayload,
        contents: model.prFileContents,
        drafts: model.prFileCommentDrafts,
        refreshSeq: model.detailRefreshSeq,
        error: model.error,
        mutating: model.mutatingStatus
      })
    })
  }
  function hostedStatus(item: Record<string, unknown>) {
    return (context: Parameters<MountAdapter>[0]) =>
      mountModelHook(context, {
        useHook: (model) =>
          load<typeof import('../../../tasks/use-mobile-tasks-gitlab-github-status-actions')>(
            'use-mobile-tasks-gitlab-github-status-actions.tsx'
          ).useMobileTasksGitlabGithubStatusActions(model),
        fixture: {
          detailPayload: item.provider === 'github' ? githubDetailPayload() : gitlabDetailPayload(),
          loadTasks: async () => {},
          mutatingStatus: false,
          actionItem: item,
          items: [item],
          error: ''
        },
        actions: ({ actions }) => ({
          'gitlab-status': () => actions().toggleGitLabStatus(mountFixture(item)),
          'github-metadata': () =>
            actions().updateGitHubIssueMetadata(mountFixture(GITHUB_ISSUE_ITEM), {
              title: 'Renamed',
              addLabels: ['triage'],
              removeLabels: ['bug']
            })
        }),
        state: (model) => ({
          payload: model.detailPayload,
          item: model.actionItem,
          items: model.items,
          error: model.error,
          mutating: model.mutatingStatus
        })
      })
  }
  return {
    'tasks.item-checks-files-github': checkFiles,
    'tasks.item-status-gitlab': hostedStatus(GITLAB_ISSUE_ITEM),
    'tasks.item-status-gitlab-mr': hostedStatus(GITLAB_MR_ITEM)
  }
}
