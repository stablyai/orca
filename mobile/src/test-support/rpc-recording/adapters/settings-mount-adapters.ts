import type * as UsePrBotAuthorOverridesModule from '../../../source-control/review/use-pr-bot-author-overrides'
import type * as UseNewWorkspaceRuntimeContextModule from '../../../components/use-new-workspace-runtime-context'
import type * as UseHostRepoMetadataModule from '../../../host-screen/use-host-repo-metadata'
import type * as UseMobileTasksRuntimeHydrationModule from '../../../tasks/use-mobile-tasks-runtime-hydration'
import { notifyManager, useQueryClient, type QueryClient } from '@tanstack/react-query'
import type * as HostListQueries from '../../../host-screen/host-list-queries'
import type * as ResumeMetadata from '../../../agent-history/mobile-agent-history-resume-metadata'
import { hostQueryKey, hostScopeKey } from '../../../query/host-query-key'
import type { OperationExposure } from '../operation-module-loader'
import type { MountAdapter } from '../recording-scenario'
import { hookMount } from '../hook-mount'
import { observableModel, projectObservable } from '../observable-model'
import { operationModuleLoader } from '../operation-module-loader'

// TanStack's own default: notify on a zero-delay timer.
const scheduleNotify = (callback: () => void) => setTimeout(callback, 0)

export const settingsMountExposures: readonly OperationExposure[] = []

export function settingsMountAdapters(
  modules: ReturnType<typeof operationModuleLoader>
): Record<string, MountAdapter> {
  return {
    'settings.bot-overrides': ({ client }) => {
      const useOverrides = modules.load<typeof UsePrBotAuthorOverridesModule>(
        'mobile/src/source-control/review/use-pr-bot-author-overrides.ts'
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
      const useContext = modules.load<typeof UseNewWorkspaceRuntimeContextModule>(
        'mobile/src/components/use-new-workspace-runtime-context.ts'
      ).useNewWorkspaceRuntimeContext
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
    'settings.resume-metadata': ({ client }) => {
      const load = modules.load<typeof ResumeMetadata>(
        'mobile/src/agent-history/mobile-agent-history-resume-metadata.ts'
      ).loadMobileResumeMetadata
      return { action: () => load(client), state: () => ({}), dispose: () => {} }
    },
    'settings.repo-metadata': (context) => {
      const useMetadata = modules.load<typeof UseHostRepoMetadataModule>(
        'mobile/src/host-screen/use-host-repo-metadata.ts'
      ).useHostRepoMetadata
      const queries = modules.load<typeof HostListQueries>(
        'mobile/src/host-screen/host-list-queries.ts'
      )
      const state = observableModel(context, { clientRef: { current: context.client } })
      // A fault schedule ends with the read settling on a timeout, after the recorder's last zero-time drain; deliver
      // TanStack's notifications as microtasks so that read's notify is not left as a timer.
      notifyManager.setScheduler(queueMicrotask)
      // Mounted unread, like a list under another screen; `load` brings it on top.
      let subscribed = false
      let queryClient: QueryClient | undefined
      const hook = hookMount(() => {
        queryClient = useQueryClient()
        useMetadata({
          client: context.client,
          hostId: 'host-1',
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the recorder supplies only the members the hook reads.
          state: state as unknown as Parameters<typeof useMetadata>[0]['state'],
          subscribed
        })
      })
      const query = () =>
        queryClient?.getQueryCache().find({
          queryKey: hostQueryKey(
            'host-1',
            queries.hostRepoCatalogQuery.family,
            queries.HOST_LIST_TARGET,
            queries.NO_HOST_LIST_INPUT
          ),
          exact: true
        })
      return {
        action(name) {
          if (name === 'mount') {
            return hook.mount()
          }
          if (!subscribed) {
            subscribed = true
            hook.update()
            // Settles with the read the list started on coming on top; failures show in the state.
            return query()
              ?.fetch()
              .then(
                () => undefined,
                () => undefined
              )
          }
          if (name === 'load-cached') {
            // A return to the list: the remount reads again only what the family's staleTime calls stale.
            hook.leave()
            hook.mount()
            const current = query()
            return current?.state.fetchStatus === 'fetching'
              ? current.fetch().then(
                  () => undefined,
                  () => undefined
                )
              : undefined
          }
          // A change event.
          return queryClient?.invalidateQueries({ queryKey: hostScopeKey('host-1') })
        },
        state: () =>
          projectObservable(
            Object.fromEntries(Object.entries(state).filter(([key]) => !key.endsWith('Ref')))
          ),
        dispose: async () => {
          await hook.unmount()
          notifyManager.setScheduler(scheduleNotify)
        }
      }
    },
    'settings.task-hydration': (context) => {
      const useHydration = modules.load<typeof UseMobileTasksRuntimeHydrationModule>(
        'mobile/src/tasks/use-mobile-tasks-runtime-hydration.tsx'
      ).useMobileTasksRuntimeHydration
      const model = observableModel(context, {
        client: context.client,
        connState: 'connected',
        hostId: 'host-1',
        jiraStatusRequestIdRef: { current: 0 },
        defaultLinearTeamSelectionRef: { current: null },
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
      // Hydration reads through the query cache; as in settings.repo-metadata, a fault schedule's last read must not leave a notify timer.
      notifyManager.setScheduler(queueMicrotask)
      const hook = hookMount(() => {
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the recorder supplies only the members the hook reads.
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
        dispose: async () => {
          await hook.unmount()
          notifyManager.setScheduler(scheduleNotify)
        }
      }
    }
  }
}
