import { hookMount, performHookAction } from '../hook-mount'
import { observableModel, projectObservable } from '../observable-model'
import type { MountAdapter, MountContext, MountedOperation } from '../recording-scenario'
import type { operationModuleLoader } from '../operation-module-loader'

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

/** The one hosted repository every task family queries, shaped the way `isHostedTaskRepo` needs. */
const HOSTED_REPO = { id: REPO_ID, displayName: 'Repo', path: '/repo', provider: 'github' }

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

const LINEAR_ITEM = {
  provider: 'linear',
  title: 'A Linear issue',
  source: {
    id: 'issue-1',
    workspaceId: 'linear-workspace',
    identifier: 'ENG-1',
    workspaceName: 'Workspace',
    url: '',
    description: '',
    labels: [],
    priority: 0,
    updatedAt: '2020-01-01T00:00:00.000Z',
    state: { name: 'Todo', type: 'unstarted', color: '#000000' },
    team: { id: 'team-1', key: 'ENG', name: 'Engineering', workspaceId: 'linear-workspace' },
    project: null,
    subIssues: []
  }
} as const

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
 * The label and assignee pickers behind one item's metadata sheet, and the Linear team context the
 * composer and the status picker share. Both keep a `stale` guard between request and commit.
 */
export function taskItemMetadataMountAdapters(
  modules: ReturnType<typeof operationModuleLoader>
): Record<string, MountAdapter> {
  const load = <T>(file: string): T => modules.load<T>(`mobile/src/tasks/${file}`)
  const itemMetadata: MountAdapter = (context) => {
    const useEffects = load<
      typeof import('../../../tasks/use-mobile-tasks-item-detail-metadata-effects')
    >('use-mobile-tasks-item-detail-metadata-effects.tsx').useMobileTasksItemDetailMetadataEffects
    return mountModelHook(context, {
      useHook: (model) => useEffects(model),
      fixture: {
        actionItem: GITHUB_ISSUE_ITEM,
        detailPayload: githubDetailPayload(),
        tasksSupported: true,
        itemAvailableLabels: [],
        itemAvailableLabelsError: '',
        itemLabelsLoading: false,
        itemLabelsError: '',
        itemAssignableUsers: [],
        itemAssignableUsersLoading: false,
        itemAssignableUsersError: '',
        itemBodyDraft: ''
      },
      actions: () => ({}),
      state: (model) => ({
        labels: model.itemAvailableLabels,
        labelsError: model.itemLabelsError,
        labelsLoading: model.itemLabelsLoading,
        users: model.itemAssignableUsers,
        usersError: model.itemAssignableUsersError,
        usersLoading: model.itemAssignableUsersLoading
      })
    })
  }
  const linearTeamContext: MountAdapter = (context) => {
    const useEffects = load<
      typeof import('../../../tasks/use-mobile-tasks-list-and-detail-effects')
    >('use-mobile-tasks-list-and-detail-effects.tsx').useMobileTasksListAndDetailEffects
    return mountModelHook(context, {
      useHook: (model) => useEffects(model),
      fixture: {
        actionItem: null,
        activeGitHubProject: null,
        activeGitHubProjectViewId: null,
        appliedGithubProjectSearch: undefined,
        appliedQuery: '',
        connState: 'connected',
        copiedLinkResetTimerRef: { current: null },
        githubKind: 'issues',
        githubMode: 'items',
        githubPreset: 'issues',
        hostedRepos: [HOSTED_REPO],
        jiraFilter: 'assigned',
        linearConnected: true,
        linearFilter: 'all',
        linearMetadataItem: null,
        loadGitHubProjectTable: async () => {},
        loadGitHubProjects: async () => {},
        loadLinearContext: async () => {},
        loadTasks: async () => {},
        persistTaskResumeState: () => {},
        provider: 'linear',
        refreshJiraConnection: async () => {},
        query: '',
        refreshTasks: () => {},
        selectGitHubProject: async () => {},
        showCreateTask: false,
        showGitHubProjectPicker: false,
        taskStateHydrated: true,
        taskUiReady: true,
        tasksSupported: true,
        linearTeams: [],
        linearStates: [],
        linearStatesLoading: false,
        createTeamId: null
      },
      actions: ({ model, update }) => ({
        'open-composer': () => {
          model.showCreateTask = true
          return update()
        },
        'select-metadata-item': () => {
          model.linearMetadataItem = LINEAR_ITEM
          return update()
        }
      }),
      state: (model) => ({
        teams: model.linearTeams,
        createTeamId: model.createTeamId,
        states: model.linearStates,
        statesLoading: model.linearStatesLoading
      })
    })
  }
  return {
    'tasks.item-detail-metadata': itemMetadata,
    'tasks.linear-team-context': linearTeamContext
  }
}
