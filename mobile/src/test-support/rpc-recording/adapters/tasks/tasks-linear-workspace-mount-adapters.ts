import type * as MobileTasksFilterSelectionModule from '../../../../tasks/screen/mobile-tasks-filter-selection'
import { performHookAction } from '../../react-mounting/hook-mount'
import { mountFixture } from '../../react-mounting/recorder-fixture-shape'
import type { operationModuleLoader } from '../../module-mounting/operation-module-loader'
import type { MountAdapter } from '../../scenarios/recording-scenario'
import type { ConnectionPresentationModel } from '../../../../tasks/screen-state/use-mobile-tasks-connection-presentation'

// Invoke the Filter sheet's actual workspace selection without mounting BottomDrawer’s native gesture/timing drivers; the scenario declares its workspace.
export function tasksLinearWorkspaceMountAdapters(
  modules: ReturnType<typeof operationModuleLoader>
): Record<string, MountAdapter> {
  return {
    'linear.select-workspace-picker': ({ client, effect }) => {
      const selectWorkspace = modules.load<typeof MobileTasksFilterSelectionModule>(
        'mobile/src/tasks/screen/mobile-tasks-filter-selection.ts'
      ).selectMobileTasksLinearWorkspace
      let selectedWorkspaceId: ConnectionPresentationModel['selectedLinearWorkspaceId'] =
        'workspace-a'
      let teamCount = 2
      let error = ''
      let contextLoads = 0
      const model = (): ConnectionPresentationModel =>
        mountFixture<ConnectionPresentationModel>({
          client,
          linearAccountBindingRef: { current: null },
          linearWorkspaceOptions: [
            { value: 'workspace-a', label: 'Acme' },
            { value: 'workspace-b', label: 'Beta' }
          ],
          loadLinearContext: () => {
            contextLoads++
            effect('linear.context-reloaded', { contextLoads })
            return Promise.resolve()
          },
          selectedLinearWorkspaceId: selectedWorkspaceId,
          setError: (next) => {
            error = typeof next === 'function' ? next(error) : next
          },
          setSelectedLinearTeamIds: (next) => {
            teamCount = (typeof next === 'function' ? next(new Set()) : next).size
          },
          setSelectedLinearWorkspaceId: (next) => {
            selectedWorkspaceId = typeof next === 'function' ? next(selectedWorkspaceId) : next
          },
          taskUiReady: true
        })
      return {
        action(name, args) {
          if (name !== 'select-workspace') {
            throw new Error(`Unknown linear workspace action: ${name}`)
          }
          const workspace = args.workspace
          if (typeof workspace !== 'string') {
            throw new Error('A workspace selection names the workspace it picks')
          }
          return performHookAction(() => selectWorkspace(model(), workspace))
        },
        state: () => ({ selectedWorkspaceId, teamCount, error, contextLoads }),
        dispose: () => {}
      }
    }
  }
}
