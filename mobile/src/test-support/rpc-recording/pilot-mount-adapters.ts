import { observableModel } from './observable-model'
import { settingsMountAdapters } from './settings-mount-adapters'
import { workspaceSettingsMounts } from './workspace-settings-mounts'
import type { MountAdapter } from './recording-scenario'
import { hookMount } from './hook-mount'
import { operationModuleLoader, type Mutation } from './operation-module-loader'

export function pilotMountAdapters(
  root: string,
  options: { reference?: boolean; mutation?: Mutation } = {}
) {
  const modules = operationModuleLoader(root, options.mutation)
  const adapters: Record<string, MountAdapter> = {
    ...settingsMountAdapters(modules),
    ...workspaceSettingsMounts(modules),
    'workspace.file-inventory': ({ client }) => {
      const useSearch = modules.load<
        typeof import('../../session/use-mobile-native-chat-file-search')
      >('mobile/src/session/use-mobile-native-chat-file-search.ts').useMobileNativeChatFileSearch
      const operations = options.reference
        ? modules
            .load('mobile/src/session/native-host-session-native-chat-operations.ts')
            .nativeHostSessionNativeChatOperations(client)
        : undefined
      let workspace = 'A'
      let state: ReturnType<typeof useSearch>
      const hook = hookMount(() => {
        state = useSearch({ client, operations, worktreeId: workspace } as Parameters<
          typeof useSearch
        >[0])
      })
      return {
        action(name, args) {
          if (name === 'mount' || name === 'remount') {
            return hook.mount()
          }
          if (name === 'unmount') {
            return hook.unmount()
          }
          if (name === 'select') {
            workspace = String(args.workspace)
            return hook.update()
          }
          if (name === 'reset') {
            const previous = workspace
            workspace = `${workspace}-reset`
            hook.update()
            workspace = previous
            return hook.update()
          }
          if (name === 'query') {
            return state.loadNativeChatFiles(String(args.query))
          }
          if (name === 'blur') {
            return
          }
          throw new Error(`Unknown inventory action: ${name}`)
        },
        state: () => ({ files: state?.nativeChatFilePaths ?? [] }),
        dispose: hook.unmount
      }
    },
    'project.update-metadata': (context) => {
      const useMetadata = modules.load<
        typeof import('../../tasks/use-mobile-tasks-project-metadata-actions')
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
        actions = useMetadata(model as unknown as Parameters<typeof useMetadata>[0])
      })
      return {
        action(name) {
          if (name === 'mount') {
            return hook.mount()
          }
          if (name === 'submit') {
            return actions.mutateProjectRowMetadata(
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
        typeof import('../../tasks/use-mobile-tasks-item-detail-loading')
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
    'settings.new-tab-agents': ({ client }) => {
      const load = modules.load<typeof import('../../session/mobile-new-tab-agent-loader')>(
        'mobile/src/session/mobile-new-tab-agent-loader.ts'
      ).loadMobileNewTabAgentOptions
      return {
        action: (_name, args) =>
          load({ client, worktreeId: String(args.workspace ?? 'repo-1::/folder') }),
        state: () => ({}),
        dispose: () => {}
      }
    },
    'settings.task-preferences': (context) => {
      const usePreferences = modules.load<
        typeof import('../../tasks/use-mobile-tasks-client-settings-actions')
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
        actions = usePreferences(model as unknown as Parameters<typeof usePreferences>[0])
      })
      return {
        action(name, args) {
          if (name === 'mount') {
            return hook.mount()
          }
          if (name === 'write') {
            return actions.persistDefaultGitHubPreset(
              args.preset as Parameters<typeof actions.persistDefaultGitHubPreset>[0]
            )
          }
          throw new Error(`Unknown preferences action: ${name}`)
        },
        state: () => ({ preset: model.defaultGitHubPreset }),
        dispose: hook.unmount
      }
    }
  }
  return { adapters, assertMutationApplied: modules.assertMutationApplied }
}
