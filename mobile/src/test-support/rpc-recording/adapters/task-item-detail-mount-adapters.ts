import { hookMount, performHookAction } from '../hook-mount'
import { observableModel, projectObservable } from '../observable-model'
import type { MountAdapter, MountContext, MountedOperation } from '../recording-scenario'
import type { operationModuleLoader } from '../operation-module-loader'

const REPO_ID = 'repo-1'

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
 * One task item's provider details. The hook keeps a `stale` guard between the request and the
 * state commit, so these families record that the guard still sits there rather than asserting it.
 */
export function taskItemDetailMountAdapters(
  modules: ReturnType<typeof operationModuleLoader>
): Record<string, MountAdapter> {
  const load = <T>(file: string): T => modules.load<T>(`mobile/src/tasks/${file}`)
  function itemDetail(item: Record<string, unknown>) {
    // Loaded on mount, not while the table is built: `task-mount-adapters.ts` mounts this same hook,
    // and a mutant anchored in it would otherwise be applied by both modules' loaders at once.
    return (context: Parameters<MountAdapter>[0]) =>
      mountModelHook(context, {
        useHook: (model) =>
          load<typeof import('../../../tasks/use-mobile-tasks-item-detail-loading')>(
            'use-mobile-tasks-item-detail-loading.tsx'
          ).useMobileTasksItemDetailLoading(model),
        fixture: {
          actionItem: item,
          detailRefreshSeq: 0,
          tasksSupported: true,
          detailLoading: false,
          detailError: '',
          detailPayload: null,
          items: [item]
        },
        actions: () => ({}),
        state: (model) => ({
          loading: model.detailLoading,
          error: model.detailError,
          payload: model.detailPayload,
          item: model.actionItem,
          items: model.items
        })
      })
  }
  return {
    'tasks.item-detail-github': itemDetail(GITHUB_PR_ITEM),
    'tasks.item-detail-gitlab': itemDetail(GITLAB_ISSUE_ITEM),
    // The Linear arm with its issue leg answered. The b3 seed refuses that leg, so its matrix
    // never reaches the comment leg's acceptance: the issue error is raised first either way.
    'tasks.item-detail-linear': itemDetail(LINEAR_ITEM)
  }
}
