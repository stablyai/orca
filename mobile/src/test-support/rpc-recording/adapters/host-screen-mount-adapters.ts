import type { MountAdapter } from '../recording-scenario'
import { hookMount, performHookAction } from '../hook-mount'
import { observableModel, projectObservable } from '../observable-model'
import type { operationModuleLoader } from '../operation-module-loader'

const HOST = 'host-1'

const INITIAL_VIEW_STATE = {
  groupMode: 'none',
  sortMode: 'recent',
  hideSleeping: false,
  hideDefaultBranch: false,
  alwaysShowDefaultBranch: true,
  filterRepoIds: [],
  collapsedGroups: [],
  workspaceStatuses: []
}

/**
 * The host screen's shared view settings, and the Home card's per-host stats read. Both belong to
 * the host list: one mirrors the desktop's workspace view store, the other fills the card's counts.
 */
export function hostScreenMountAdapters(
  modules: ReturnType<typeof operationModuleLoader>
): Record<string, MountAdapter> {
  return {
    'host.view-settings': (context) => {
      const useViewSettings = modules.load<
        typeof import('../../../host-screen/use-host-view-settings')
      >('mobile/src/host-screen/use-host-view-settings.ts').useHostViewSettings
      const state = observableModel(context, {
        clientRef: { current: context.client },
        collapsedGroups: new Set<string>(),
        filters: {
          filterRepoIds: new Set<string>(),
          hideSleeping: false,
          hideDefaultBranch: false,
          alwaysShowDefaultBranch: true
        },
        groupMode: 'none',
        sortMode: 'recent',
        viewStateRef: { current: { ...INITIAL_VIEW_STATE } },
        workspaceStatuses: []
      })
      let actions: ReturnType<typeof useViewSettings>
      const hook = hookMount(() => {
        actions = useViewSettings({
          client: context.client,
          connState: 'connected',
          hostId: HOST,
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the recorder supplies only the members the hook reads.
          state: state as unknown as Parameters<typeof useViewSettings>[0]['state']
        })
      })
      return {
        action(name) {
          if (name === 'mount') {
            return hook.mount()
          }
          if (name === 'sync') {
            return actions.syncViewSettingsFromDesktop()
          }
          if (name === 'sort') {
            return performHookAction(() => actions.handleSortChange('name'))
          }
          if (name === 'hide-sleeping') {
            return performHookAction(() => actions.toggleHideSleeping())
          }
          throw new Error(`Unknown view settings action: ${name}`)
        },
        state: () =>
          projectObservable({
            groupMode: state.groupMode,
            sortMode: state.sortMode,
            filters: state.filters,
            collapsed: state.collapsedGroups,
            statuses: state.workspaceStatuses
          }),
        dispose: hook.unmount
      }
    },
    'home.host-stats': (context) => {
      const fetchStats = modules.load(
        'mobile/src/home/mobile-home-host-requests.ts'
      ).fetchMobileHomeStats
      let stats: Record<string, unknown> = {}
      let disposed = false
      return {
        action(name) {
          if (name === 'unmount') {
            disposed = true
            return
          }
          return fetchStats(
            context.client,
            HOST,
            (update: (value: Record<string, unknown>) => Record<string, unknown>) => {
              stats = update(stats)
              context.effect('stats', stats)
            },
            () => disposed
          )
        },
        state: () => ({ ...stats }),
        dispose: () => {
          disposed = true
        }
      }
    }
  }
}
