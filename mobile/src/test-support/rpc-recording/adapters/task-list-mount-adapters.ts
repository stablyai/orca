import { hookMount, performHookAction } from '../hook-mount'
import { observableModel, projectObservable } from '../observable-model'
import type { MountAdapter, MountContext, MountedOperation } from '../recording-scenario'
import type { operationModuleLoader } from '../operation-module-loader'
import { mountFixture } from '../recorder-fixture-shape'

const REPO_ID = 'repo-1'

/** The one hosted repository every task family queries, shaped the way `isHostedTaskRepo` needs. */
const HOSTED_REPO = { id: REPO_ID, displayName: 'Repo', path: '/repo', provider: 'github' }

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
 * The task list screen's loads and the composer's writes: provider item pages and counts, the
 * Linear account context, the list query itself, connecting Linear, and creating a task. Every one
 * of these keeps a generation guard between the request and the state commit.
 */
export function taskListMountAdapters(
  modules: ReturnType<typeof operationModuleLoader>
): Record<string, MountAdapter> {
  const load = <T>(file: string): T => modules.load<T>(`mobile/src/tasks/${file}`)

  const providerLoad: MountAdapter = (context) => {
    const useActions = load<typeof import('../../../tasks/use-mobile-tasks-provider-load-actions')>(
      'use-mobile-tasks-provider-load-actions.tsx'
    ).useMobileTasksProviderLoadActions
    return mountModelHook(context, {
      useHook: (model) => useActions(model),
      fixture: {
        appliedQuery: 'bug',
        connState: 'connected',
        defaultLinearTeamSelectionRef: { current: null },
        githubKind: 'issues',
        taskUiReady: true,
        tasksSupported: true,
        linearConnected: false,
        linearTeams: [],
        linearWorkspaces: [],
        selectedLinearTeamIds: new Set<string>(),
        selectedLinearWorkspaceId: null
      },
      actions: ({ actions }) => ({
        'linear-context': () => actions().loadLinearContext(),
        'persist-teams': () =>
          actions().persistLinearTeamSelection(
            new Set(['team-1']),
            mountFixture([{ id: 'team-1' }, { id: 'team-2' }])
          ),
        // `context.client` rather than `model.client`: the model holds that same client under an
        // `unknown` fixture record, and reading it there would need a cast the context does not.
        'github-page': () =>
          actions().fetchGitHubItemsPage(context.client, mountFixture([HOSTED_REPO])),
        'github-count': () =>
          actions().countGitHubItems(context.client, mountFixture([HOSTED_REPO]))
      }),
      state: (model) => ({
        connected: model.linearConnected,
        teams: model.linearTeams,
        workspaces: model.linearWorkspaces,
        selectedTeams: model.selectedLinearTeamIds,
        workspaceId: model.selectedLinearWorkspaceId
      })
    })
  }

  function taskList(provider: string, extra: Record<string, unknown>) {
    return (context: Parameters<MountAdapter>[0]) =>
      mountModelHook(context, {
        useHook: (model) =>
          load<typeof import('../../../tasks/use-mobile-tasks-task-list-loading')>(
            'use-mobile-tasks-task-list-loading.tsx'
          ).useMobileTasksTaskListLoading(model),
        fixture: {
          appliedQuery: '',
          clientRef: { current: context.client },
          connState: 'connected',
          countGitHubItems: async () => 0,
          fetchGitHubItemsPage: async () => ({
            items: [],
            failedCount: 0,
            sourcesByRepoId: {},
            sourceErrors: [],
            sourceFallbacks: []
          }),
          githubMode: 'items',
          gitlabFilter: 'opened',
          gitlabView: 'project',
          linearConnected: true,
          linearFilter: 'all',
          linearOrderBy: 'priority',
          loadGenerationRef: { current: 0 },
          provider,
          repoListEnsureLoaded: async () => [HOSTED_REPO],
          resetGitHubItemsState: () => {},
          selectedLinearTeamIds: new Set<string>(),
          selectedLinearWorkspaceId: 'linear-workspace',
          selectedRepoIds: new Set<string>(),
          taskStateHydrated: true,
          tasksSupported: true,
          items: [],
          error: '',
          loading: false,
          refreshing: false,
          ...extra
        },
        actions: ({ actions, model, update }) => ({
          load: () => actions().loadTasks(),
          // Re-renders and sends nothing: loadTasks is a useCallback over appliedQuery, so the
          // search arm is only reachable through a rebuilt closure.
          'set-query': (args) => {
            model.appliedQuery = String(args.query ?? '')
            return update()
          }
        }),
        state: (model) => ({
          items: model.items,
          error: model.error,
          loading: model.loading,
          refreshing: model.refreshing
        })
      })
  }

  const linearConnect: MountAdapter = (context) => {
    const useActions = load<
      typeof import('../../../tasks/use-mobile-tasks-task-pagination-actions')
    >('use-mobile-tasks-task-pagination-actions.tsx').useMobileTasksTaskPaginationActions
    return mountModelHook(context, {
      useHook: (model) => useActions(model),
      fixture: {
        connState: 'connected',
        fetchGitHubItemsPage: async () => ({ items: [], failedCount: 0 }),
        githubCurrentPage: 0,
        githubPages: [[]],
        githubPaginationLoading: false,
        githubTotalCount: null,
        linearApiKeyDraft: 'lin_api_key',
        linearConnectState: 'idle',
        loadLinearContext: async () => {},
        loadTasks: async () => {},
        selectedHostedRepos: [HOSTED_REPO],
        taskUiReady: true,
        tasksSupported: true,
        linearConnectError: '',
        linearConnected: false,
        provider: 'github',
        visibleProviders: ['github'],
        showLinearConnect: true
      },
      actions: ({ actions }) => ({ connect: () => actions().connectLinearAccount() }),
      state: (model) => ({
        state: model.linearConnectState,
        error: model.linearConnectError,
        connected: model.linearConnected,
        provider: model.provider,
        providers: model.visibleProviders
      })
    })
  }

  function taskCreate(provider: string) {
    return (context: Parameters<MountAdapter>[0]) =>
      mountModelHook(context, {
        useHook: (model) =>
          load<typeof import('../../../tasks/use-mobile-tasks-task-create-actions')>(
            'use-mobile-tasks-task-create-actions.tsx'
          ).useMobileTasksTaskCreateActions(model),
        fixture: {
          createBody: 'a body',
          createRepoId: REPO_ID,
          createTeamId: 'team-1',
          createTitle: 'A new task',
          creatingTask: false,
          hostedRepos: [HOSTED_REPO],
          linearTeams: [
            { id: 'team-1', workspaceId: 'linear-workspace', workspaceName: 'Workspace' }
          ],
          loadTasks: async () => {},
          provider,
          repoListReload: async () => [HOSTED_REPO],
          taskStateHydrated: true,
          taskUiReady: true,
          tasksSupported: true,
          actionItem: null,
          error: '',
          showCreateTask: true
        },
        actions: ({ actions }) => ({
          create: () => actions().createTask(),
          'issue-source': () =>
            actions().setGitHubIssueSourcePreference(mountFixture(HOSTED_REPO), 'upstream')
        }),
        state: (model) => ({
          item: model.actionItem,
          error: model.error,
          creating: model.creatingTask,
          composer: model.showCreateTask
        })
      })
  }

  return {
    'tasks.provider-load': providerLoad,
    'tasks.task-list-gitlab-todos': taskList('gitlab', { gitlabView: 'todos' }),
    'tasks.task-list-gitlab-items': taskList('gitlab', {}),
    'tasks.task-list-linear': taskList('linear', {}),
    'tasks.linear-connect': linearConnect,
    'tasks.task-create-github': taskCreate('github'),
    'tasks.task-create-gitlab': taskCreate('gitlab'),
    'tasks.task-create-linear': taskCreate('linear')
  }
}
