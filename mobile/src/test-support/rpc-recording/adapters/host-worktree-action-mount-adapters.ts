import type { MountAdapter } from '../recording-scenario'
import { hookMount, performHookAction } from '../hook-mount'
import { observableModel, projectObservable } from '../observable-model'
import type { operationModuleLoader } from '../operation-module-loader'

const ROW = {
  worktreeId: 'wt-1',
  repoId: 'repo-1',
  repo: 'marlin',
  branch: 'feature/pin',
  displayName: 'marlin',
  path: '/repos/marlin/wt-1',
  liveTerminalCount: 0,
  hasAttachedPty: false,
  preview: '',
  unread: false,
  isPinned: false,
  linkedPR: null
}

/**
 * The host screen's three worktree mutations: pin, delete and open.
 *
 * Mounted with no hostId, which is the only thing that keeps the hook off native storage: the
 * pinned-id write is the sole native call and it sits behind `if (hostId)`.
 */
export function hostWorktreeActionMountAdapters(
  modules: ReturnType<typeof operationModuleLoader>
): Record<string, MountAdapter> {
  return {
    'host.worktree-actions': (context) => {
      const useActions = modules.load<
        typeof import('../../../host-screen/use-host-worktree-actions')
      >('mobile/src/host-screen/use-host-worktree-actions.ts').useHostWorktreeActions
      const state = observableModel(context, {
        newWorktreeModalRef: { current: null },
        newWorktreeModalVisibleRef: { current: false },
        pinnedIds: new Set<string>(),
        worktrees: [ROW],
        lastKnownWorktrees: [ROW],
        confirmRemoveHost: false,
        optimisticActiveWorktreeIdentity: null,
        routeActionState: {}
      })
      let actions: ReturnType<typeof useActions>
      const hook = hookMount(() => {
        actions = useActions({
          client: context.client,
          connState: 'connected',
          embedded: false,
          fetchWorktrees: async () => {},
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the hook only forwards this to host removal, which no scenario drives.
          forgetHostClient: (() => {}) as unknown as Parameters<
            typeof useActions
          >[0]['forgetHostClient'],
          hostId: undefined,
          pathname: '/h/host-1',
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: navigation is observed through the recorded sends, not the router.
          router: { push: () => {}, replace: () => {} } as unknown as Parameters<
            typeof useActions
          >[0]['router'],
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the recorder supplies only the members the hook reads.
          state: state as unknown as Parameters<typeof useActions>[0]['state']
        })
      })
      return {
        action(name) {
          if (name === 'mount') {
            return hook.mount()
          }
          if (name === 'toggle-pin') {
            return performHookAction(() => actions.togglePin(ROW.worktreeId))
          }
          if (name === 'delete') {
            return performHookAction(() => actions.handleDeleteWorktree(ROW))
          }
          if (name === 'open-session') {
            return performHookAction(() => actions.openWorktreeSession(ROW))
          }
          throw new Error(`Unknown worktree action: ${name}`)
        },
        state: () =>
          projectObservable(
            Object.fromEntries(Object.entries(state).filter(([key]) => !key.endsWith('Ref')))
          ),
        dispose: hook.unmount
      }
    }
  }
}
