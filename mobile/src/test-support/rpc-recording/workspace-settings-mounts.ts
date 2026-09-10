import type { MountAdapter } from './recording-scenario'
import { hookMount } from './hook-mount'
import { observableModel, projectObservable } from './observable-model'
import { operationModuleLoader } from './operation-module-loader'

export function workspaceSettingsMounts(
  modules: ReturnType<typeof operationModuleLoader>
): Record<string, MountAdapter> {
  return {
    'settings.workspace-submit': (context) => {
      const useSubmit = modules.load<
        typeof import('../../components/use-new-workspace-create-submit')
      >('mobile/src/components/use-new-workspace-create-submit.ts').useNewWorkspaceCreateSubmit
      const model = observableModel(context, {
        client: context.client,
        selectedRepo: { id: 'repo-1', displayName: 'Repo' },
        selectedAgent: { id: 'claude', label: 'Claude' },
        runtimeSettings: { disabledTuiAgents: ['claude'] },
        detectedAgentIds: new Set(['codex']),
        sshGate: { requiresConnection: false },
        composer: { name: 'recorded', createSelection: null, isNameAutoManaged: false },
        note: '',
        retiredWorktreeNames: {},
        setupCommand: null,
        setupTrust: null,
        setupRunPolicy: 'never',
        setupDecisionChoice: null,
        runSetup: false,
        trustedOrcaHooks: {},
        getWorktreeCreateCutoverSupport: async () => false,
        transitionDrawer: (view: unknown) => context.effect('drawer', view),
        onCreated: (id: unknown, name: unknown) => context.effect('created', { id, name }),
        onClose: () => context.effect('close', null)
      })
      let state: ReturnType<typeof useSubmit>
      const hook = hookMount(() => {
        state = useSubmit(model as unknown as Parameters<typeof useSubmit>[0])
      })
      return {
        action(name) {
          if (name === 'mount') {
            return hook.mount()
          }
          if (name === 'submit') {
            return state.create()
          }
          throw new Error(`Unknown submit action: ${name}`)
        },
        state: () =>
          projectObservable({
            creating: state?.creating,
            settings: model.runtimeSettings,
            error: model.error
          }),
        dispose: hook.unmount
      }
    },
    'settings.task-workspace': (context) => {
      const useCreate = modules.load<
        typeof import('../../tasks/use-mobile-tasks-workspace-create-actions')
      >(
        'mobile/src/tasks/use-mobile-tasks-workspace-create-actions.tsx'
      ).useMobileTasksWorkspaceCreateActions
      const model = observableModel(context, {
        client: context.client,
        hostId: 'host-1',
        tasksSupported: true,
        taskStateHydrated: true,
        runtimeTaskSettings: { disabledTuiAgents: ['claude'] },
        trustedOrcaHooks: {},
        workspaceDetectedAgentIds: new Set(['codex']),
        workspaceLastAutoName: '',
        ensureWorkspaceSshReady: async () => {},
        getWorkspaceTargetRepo: () => ({
          id: 'repo-1',
          displayName: 'Repo',
          connectionId: 'ssh-1'
        }),
        resolveCreateSetupDecision: async () => ({
          kind: 'prompt',
          command: 'setup',
          source: 'repo'
        }),
        router: { push: (value: unknown) => context.effect('navigation', value) }
      })
      let actions: ReturnType<typeof useCreate>
      const hook = hookMount(() => {
        actions = useCreate(model as unknown as Parameters<typeof useCreate>[0])
      })
      return {
        action(name) {
          if (name === 'mount') {
            return hook.mount()
          }
          if (name === 'submit') {
            return actions.createWorkspace(
              { key: 'linear:1', provider: 'linear', source: { id: 'issue-1' } } as Parameters<
                typeof actions.createWorkspace
              >[0],
              undefined,
              undefined,
              'claude'
            )
          }
          throw new Error(`Unknown task workspace action: ${name}`)
        },
        state: () =>
          projectObservable({
            settings: model.runtimeTaskSettings,
            error: model.error,
            creating: model.creatingKey
          }),
        dispose: hook.unmount
      }
    }
  }
}
