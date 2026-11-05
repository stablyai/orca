import { isValidElement } from 'react'
import { performHookAction } from '../hook-mount'
import { mountFixture } from '../recorder-fixture-shape'
import type { operationModuleLoader } from '../operation-module-loader'
import type { MountAdapter } from '../recording-scenario'
import type { ConnectionPresentationModel } from '../../../tasks/use-mobile-tasks-connection-presentation'

// Invoke the render helper’s actual onSelect without mounting BottomDrawer’s native gesture/timing drivers; the scenario declares its workspace.
export function tasksLinearWorkspaceMountAdapters(
  modules: ReturnType<typeof operationModuleLoader>
): Record<string, MountAdapter> {
  return {
    'linear.select-workspace-picker': ({ client, effect }) => {
      const renderPicker = modules.load<
        typeof import('../../../tasks/mobile-tasks-filter-pickers')
      >('mobile/src/tasks/mobile-tasks-filter-pickers.tsx').renderMobileTasksLinearWorkspacePicker
      let selectedWorkspaceId: ConnectionPresentationModel['selectedLinearWorkspaceId'] =
        'workspace-a'
      let teamCount = 2
      let error = ''
      let contextLoads = 0
      const model = (): ConnectionPresentationModel =>
        mountFixture<ConnectionPresentationModel>({
          client,
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
          setShowLinearWorkspacePicker: () => {},
          showLinearWorkspacePicker: true,
          taskUiReady: true
        })
      return {
        action(name, args) {
          if (name !== 'select-workspace') {
            throw new Error(`Unknown linear workspace action: ${name}`)
          }
          const element = renderPicker(model())
          if (!isValidElement<{ onSelect?: unknown }>(element)) {
            throw new Error('The workspace picker rendered no element')
          }
          const select = element.props.onSelect
          if (typeof select !== 'function') {
            throw new Error('The workspace picker carries no onSelect')
          }
          const workspace = args.workspace
          if (typeof workspace !== 'string') {
            throw new Error('A workspace selection names the workspace it picks')
          }
          return performHookAction(() => select(workspace))
        },
        state: () => ({ selectedWorkspaceId, teamCount, error, contextLoads }),
        dispose: () => {}
      }
    }
  }
}
