import type * as HostViewSettingsModule from '../../../host-screen/view-settings/use-host-view-settings'
import type { MountAdapter } from '../recording-scenario'
import { INITIAL_MOBILE_VIEW } from '../../../worktree/workspace-list/workspace-view-settings'
import { hookMount, performHookAction } from '../hook-mount'
import { observableModel, projectObservable } from '../observable-model'
import type { operationModuleLoader } from '../operation-module-loader'

export function hostScreenMountAdapters(
  modules: ReturnType<typeof operationModuleLoader>
): Record<string, MountAdapter> {
  return {
    'host.view-settings': (context) => {
      const useViewSettings = modules.load<typeof HostViewSettingsModule>(
        'mobile/src/host-screen/view-settings/use-host-view-settings.ts'
      ).useHostViewSettings
      const state = observableModel(context, {
        clientRef: { current: context.client },
        view: INITIAL_MOBILE_VIEW,
        viewRef: { current: INITIAL_MOBILE_VIEW },
        rememberView: () => {}
      })
      let actions: ReturnType<typeof useViewSettings>
      const hook = hookMount(() => {
        actions = useViewSettings({
          client: context.client,
          connState: 'connected',
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
            return performHookAction(() => actions.setFilter('hideSleepingWorkspaces', true))
          }
          throw new Error(`Unknown view settings action: ${name}`)
        },
        state: () => projectObservable({ view: state.view }),
        dispose: hook.unmount
      }
    }
  }
}
