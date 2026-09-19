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

const PROJECT_HOST = 'github.enterprise.test'

const PROJECT_REPO = { id: REPO_ID, displayName: 'Repo', path: '/repo' }

const ISSUE_ROW = {
  id: 'item-1',
  itemType: 'ISSUE',
  content: {
    repository: 'owner/repo',
    number: 1,
    url: 'https://github.com/owner/repo/issues/1',
    state: 'OPEN',
    labels: [],
    assignees: [],
    issueType: null
  },
  fieldValuesByFieldId: {}
} as const

const PR_ROW = {
  id: 'item-2',
  itemType: 'PULL_REQUEST',
  content: {
    repository: 'owner/repo',
    number: 2,
    url: 'https://github.com/owner/repo/pull/2',
    state: 'OPEN',
    labels: [],
    assignees: [],
    issueType: null
  },
  fieldValuesByFieldId: {}
} as const

const STATUS_FIELD = {
  id: 'field-1',
  name: 'Status',
  dataType: 'SINGLE_SELECT',
  options: []
}

const PROJECT_TABLE = {
  project: { id: 'project-1', title: 'Board', number: 3 },
  selectedView: { id: 'view-1', number: 1, name: 'Table', filter: '', layout: 'TABLE_LAYOUT' },
  fields: [STATUS_FIELD],
  rows: [ISSUE_ROW, PR_ROW]
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
 * Writing on a board row's conversation: review threads and their replies, and plain comments on
 * an issue or a pull-request row.
 */
export function taskProjectRowCommentMountAdapters(
  modules: ReturnType<typeof operationModuleLoader>
): Record<string, MountAdapter> {
  const load = <T>(file: string): T => modules.load<T>(`mobile/src/tasks/${file}`)
  const boardFixture = {
    activeGitHubProjectHost: PROJECT_HOST,
    findProjectRowRepo: () => PROJECT_REPO,
    projectMutating: false,
    projectRowDetail: githubDetailPayload(),
    projectRowItem: ISSUE_ROW,
    githubProjectTable: PROJECT_TABLE,
    projectRowDetailError: '',
    projectRowDetailRefreshSeq: 0
  }
  const rowThreads: MountAdapter = (context) => {
    const useActions = load<
      typeof import('../../../tasks/use-mobile-tasks-project-thread-reply-actions')
    >('use-mobile-tasks-project-thread-reply-actions.tsx').useMobileTasksProjectThreadReplyActions
    return mountModelHook(context, {
      useHook: (model) => useActions(model),
      fixture: {
        ...boardFixture,
        projectRowItem: PR_ROW,
        itemReplyDrafts: { '501': 'a reply', 'comment-2': 'a reply' },
        projectEditingCommentId: null,
        projectEditingCommentDraft: ''
      },
      actions: ({ actions }) => ({
        'delete-comment': () =>
          actions().deleteProjectRowComment(
            mountFixture(PR_ROW),
            mountFixture({ ...REVIEW_COMMENT })
          ),
        thread: () =>
          actions().toggleProjectGitHubReviewThread(
            mountFixture(PR_ROW),
            mountFixture(REVIEW_COMMENT)
          ),
        'review-reply': () =>
          actions().replyToProjectGitHubComment(mountFixture(PR_ROW), mountFixture(REVIEW_COMMENT)),
        'issue-reply': () =>
          actions().replyToProjectGitHubComment(mountFixture(PR_ROW), mountFixture(ISSUE_COMMENT))
      }),
      state: (model) => ({
        detail: model.projectRowDetail,
        error: model.projectRowDetailError,
        mutating: model.projectMutating
      })
    })
  }
  function rowComments(row: Record<string, unknown>) {
    return (context: Parameters<MountAdapter>[0]) =>
      mountModelHook(context, {
        useHook: (model) =>
          load<typeof import('../../../tasks/use-mobile-tasks-project-workspace-comment-actions')>(
            'use-mobile-tasks-project-workspace-comment-actions.tsx'
          ).useMobileTasksProjectWorkspaceCommentActions(model),
        fixture: {
          ...boardFixture,
          projectRowItem: row,
          openWorkspaceCreate: () => {},
          projectCommentDraft: 'a project comment',
          projectEditingCommentDraft: 'an edited comment',
          projectEditingCommentId: '501',
          tasksSupported: true,
          error: '',
          projectRepoNotInOrca: null
        },
        actions: ({ actions }) => ({
          'update-item': () =>
            actions().mutateProjectRowIssueOrPr(mountFixture(row), { title: 'Renamed' }),
          'add-comment': () => actions().addProjectRowComment(mountFixture(row)),
          'update-comment': () =>
            actions().updateProjectRowComment(mountFixture(row), mountFixture(REVIEW_COMMENT))
        }),
        state: (model) => ({
          row: model.projectRowItem,
          detail: model.projectRowDetail,
          error: model.projectRowDetailError,
          mutating: model.projectMutating
        })
      })
  }
  return {
    'tasks.project-row-threads': rowThreads,
    'tasks.project-row-comments-issue': rowComments(ISSUE_ROW),
    'tasks.project-row-comments-pr': rowComments(PR_ROW)
  }
}
