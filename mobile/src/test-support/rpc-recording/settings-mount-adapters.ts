import type { MountAdapter } from './recording-scenario'
import { hookMount } from './hook-mount'
import { observableModel, projectObservable } from './observable-model'
import { operationModuleLoader } from './operation-module-loader'

export function settingsMountAdapters(
  modules: ReturnType<typeof operationModuleLoader>
): Record<string, MountAdapter> {
  return {
    'settings.bot-overrides': ({ client }) => {
      const useOverrides = modules.load<typeof import('../../session/use-pr-bot-author-overrides')>(
        'mobile/src/session/use-pr-bot-author-overrides.ts'
      ).usePRBotAuthorOverrides
      let state: ReadonlySet<string> = new Set()
      let revision = 1
      const hook = hookMount(() => {
        state = useOverrides(client, 'connected', revision)
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
            revision++
            return hook.update()
          }
          if (name === 'blur') {
            return
          }
          throw new Error(`Unknown overrides action: ${name}`)
        },
        state: () => [...state],
        dispose: hook.unmount
      }
    },
    'settings.workspace-context': ({ client }) => {
      const useContext = modules.load<
        typeof import('../../components/use-new-workspace-runtime-context')
      >('mobile/src/components/use-new-workspace-runtime-context.ts').useNewWorkspaceRuntimeContext
      let state: ReturnType<typeof useContext>
      let visible = true
      const hook = hookMount(() => {
        state = useContext(client, visible, 'host-1')
      })
      return {
        action(name) {
          if (name === 'mount' || name === 'remount') {
            return hook.mount()
          }
          if (name === 'unmount') {
            return hook.unmount()
          }
          if (name === 'blur') {
            visible = false
            return hook.update()
          }
          if (name === 'reset') {
            visible = true
            return hook.update()
          }
          throw new Error(`Unknown context action: ${name}`)
        },
        state: () => ({
          settings: state?.runtimeSettings,
          trust: state?.trustedOrcaHooks,
          providers: state?.availableProviders
        }),
        dispose: hook.unmount
      }
    },
    'settings.home-providers': (context) => {
      const load = modules.load(
        'mobile/src/home/mobile-home-host-requests.ts'
      ).fetchMobileHomeTaskProviders
      let providers: unknown = {}
      let disposed = false
      return {
        action(name) {
          if (name === 'unmount') {
            disposed = true
            return
          }
          load(
            context.client,
            'host-1',
            (update: (value: unknown) => unknown) => {
              providers = update(providers)
              context.effect('providers', providers)
            },
            () => disposed
          )
        },
        state: () => providers,
        dispose: () => {
          disposed = true
        }
      }
    },
    'settings.resume-metadata': ({ client }) => {
      const load = modules.load(
        'mobile/src/agent-history/MobileAgentSessionHistoryPanel.tsx'
      ).loadMobileResumeMetadata
      return { action: () => load(client), state: () => ({}), dispose: () => {} }
    },
    'settings.repo-metadata': (context) => {
      const useMetadata = modules.load<typeof import('../../host-screen/use-host-repo-metadata')>(
        'mobile/src/host-screen/use-host-repo-metadata.ts'
      ).useHostRepoMetadata
      const state = observableModel(context, {
        clientRef: { current: context.client },
        fetchRepoMetadataInFlightRef: { current: new Set() },
        fetchRepoMetadataPendingRef: { current: new Set() },
        repoMetadataFetchedAtRef: { current: 0 }
      })
      let load: ReturnType<typeof useMetadata>
      const hook = hookMount(() => {
        load = useMetadata({
          client: context.client,
          connState: 'connected',
          hostId: 'host-1',
          state: state as unknown as Parameters<typeof useMetadata>[0]['state']
        })
      })
      return {
        action(name) {
          if (name === 'mount') {
            return hook.mount()
          }
          return load({ force: name !== 'load-cached' })
        },
        state: () =>
          projectObservable(
            Object.fromEntries(Object.entries(state).filter(([key]) => !key.endsWith('Ref')))
          ),
        dispose: hook.unmount
      }
    },
    'settings.task-hydration': (context) => {
      const useHydration = modules.load<
        typeof import('../../tasks/use-mobile-tasks-runtime-hydration')
      >('mobile/src/tasks/use-mobile-tasks-runtime-hydration.tsx').useMobileTasksRuntimeHydration
      const model = observableModel(context, {
        client: context.client,
        connState: 'connected',
        defaultLinearTeamSelectionRef: { current: null },
        defaultRepoSelectionRef: { current: null },
        repoSelectionHydratedRef: { current: false },
        taskResumeRef: { current: {} },
        runtimeTaskSettings: {},
        taskStateHydrated: false,
        provider: 'github',
        repoList: { state: { status: 'loading' } },
        repos: [],
        requestedTaskSource: undefined,
        resetGitHubItemsState: () => context.effect('reset-items', null),
        resetWorkspaceCreateState: () => context.effect('reset-workspace', null),
        visibleProviders: ['github']
      })
      const hook = hookMount(() => {
        useHydration(model as unknown as Parameters<typeof useHydration>[0])
      })
      return {
        action(name) {
          if (name === 'mount' || name === 'remount') {
            return hook.mount()
          }
          if (name === 'unmount') {
            return hook.unmount()
          }
          throw new Error(`Unknown hydration action: ${name}`)
        },
        state: () =>
          projectObservable({
            settings: model.runtimeTaskSettings,
            hydrated: model.taskStateHydrated
          }),
        dispose: hook.unmount
      }
    }
  }
}
