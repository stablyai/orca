import { hookMount } from '../hook-mount'
import type { MountOptions } from '../mounted-operation-module'
import { observableModel } from '../observable-model'
import { operationModuleLoader } from '../operation-module-loader'
import type { MountAdapter } from '../recording-scenario'

/** Task-model mounts: GitHub project metadata, Linear issue detail and task client settings. */
export function taskMountAdapters(
  modules: ReturnType<typeof operationModuleLoader>,
  options: MountOptions
): Record<string, MountAdapter> {
  return {
    'project.update-metadata': (context) => {
      const useMetadata = modules.load<
        typeof import('../../../tasks/use-mobile-tasks-project-metadata-actions')
      >(
        'mobile/src/tasks/use-mobile-tasks-project-metadata-actions.tsx'
      ).useMobileTasksProjectMetadataActions

      const row = {
        id: 'item-1',
        itemType: 'ISSUE',
        content: { repository: 'owner/repo', number: 1, labels: [], assignees: [] }
      }

      const model = observableModel(context, {
        projectMutating: false,
        projectRowDetailError: '',
        projectRowItem: row,
        githubProjectTable: { rows: [row] },
        projectRowDetail: null,
        projectFieldDrafts: {}
      })

      Object.assign(model, {
        client: context.client,
        activeGitHubProjectHost: 'github.enterprise.test'
      })

      if (options.reference) {
        model.taskOperations = {
          projectMutation: modules
            .load('mobile/src/tasks/native-host-task-project-mutation-operations.ts')
            .nativeHostTaskProjectMutationOperations(context.client)
        }
      }

      let actions: ReturnType<typeof useMetadata>

      const hook = hookMount(() => {
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the recorder supplies only the members the hook reads.
        actions = useMetadata(model as unknown as Parameters<typeof useMetadata>[0])
      })

      return {
        action(name) {
          if (name === 'mount') {
            return hook.mount()
          }

          if (name === 'submit') {
            return actions.mutateProjectRowMetadata(
              // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the scenario supplies the row as JSON, not as a typed model.
              row as unknown as Parameters<typeof actions.mutateProjectRowMetadata>[0],
              { addLabels: ['recorded'] }
            )
          }

          throw new Error(`Unknown project action: ${name}`)
        },
        state: () => ({
          mutating: model.projectMutating,
          error: model.projectRowDetailError,
          row: model.projectRowItem
        }),
        dispose: hook.unmount
      }
    },
    'linear.issue-detail': (context) => {
      const useDetail = modules.load<
        typeof import('../../../tasks/use-mobile-tasks-item-detail-loading')
      >('mobile/src/tasks/use-mobile-tasks-item-detail-loading.tsx').useMobileTasksItemDetailLoading

      const model = observableModel(context, {
        actionItem: {
          provider: 'linear',
          source: { id: 'issue-1', workspaceId: 'linear-workspace' }
        },
        detailLoading: false,
        detailError: '',
        detailPayload: null,
        items: []
      })

      Object.assign(model, { client: context.client, tasksSupported: true, detailRefreshSeq: 0 })

      if (options.reference) {
        model.taskOperations = {
          detail: modules
            .load('mobile/src/tasks/native-host-task-detail-operations.ts')
            .nativeHostTaskDetailOperations(context.client)
        }
      }

      const hook = hookMount(() => {
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the recorder supplies only the members the hook reads.
        useDetail(model as unknown as Parameters<typeof useDetail>[0])
      })

      return {
        action(name) {
          if (name === 'mount' || name === 'remount') {
            return hook.mount()
          }

          if (name === 'unmount') {
            return hook.unmount()
          }

          if (name === 'reset') {
            model.detailRefreshSeq = Number(model.detailRefreshSeq) + 1

            return hook.update()
          }

          if (name === 'blur') {
            return
          }

          throw new Error(`Unknown detail action: ${name}`)
        },
        state: () => ({
          loading: model.detailLoading,
          error: model.detailError,
          payload: model.detailPayload
        }),
        dispose: hook.unmount
      }
    },
    'settings.task-preferences': (context) => {
      const usePreferences = modules.load<
        typeof import('../../../tasks/use-mobile-tasks-client-settings-actions')
      >(
        'mobile/src/tasks/use-mobile-tasks-client-settings-actions.tsx'
      ).useMobileTasksClientSettingsActions

      const model = observableModel(context, {
        defaultGitHubPreset: 'all',
        githubProjectSettings: {}
      })

      Object.assign(model, {
        client: context.client,
        clientRef: { current: context.client },
        repoSelectionHydratedRef: { current: false },
        defaultRepoSelectionRef: { current: null },
        taskUiReady: true,
        githubProjectFieldVisibilityScope: null,
        taskResumeRef: { current: {} },
        trustedOrcaHooks: {}
      })
      let actions: ReturnType<typeof usePreferences>

      const hook = hookMount(() => {
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the recorder supplies only the members the hook reads.
        actions = usePreferences(model as unknown as Parameters<typeof usePreferences>[0])
      })

      return {
        action(name, args) {
          if (name === 'mount') {
            return hook.mount()
          }

          if (name === 'write') {
            return actions.persistDefaultGitHubPreset(
              // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the preset arrives from the scenario JSON as a string.
              args.preset as Parameters<typeof actions.persistDefaultGitHubPreset>[0]
            )
          }

          if (name === 'resume') {
            return actions.persistTaskResumeState({ githubItemsPreset: 'issues' })
          }

          if (name === 'trust') {
            return actions.persistSetupHookTrust('repo-1', 'hash-1', false)
          }

          throw new Error(`Unknown preferences action: ${name}`)
        },
        state: () => ({ preset: model.defaultGitHubPreset }),
        dispose: hook.unmount
      }
    }
  }
}
