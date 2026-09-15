import type { MountAdapter } from '../recording-scenario'
import { hookMount, performHookAction } from '../hook-mount'
import { observableModel, projectObservable } from '../observable-model'
import type { operationModuleLoader } from '../operation-module-loader'

const REPO = 'repo-1'

/**
 * The workspace-create drawer's three model-chained hooks, mounted the way the settings adapters
 * mount theirs: a fixture model supplying only the members the hook destructures, with every setter
 * recorded as an effect.
 */
export function taskWorkspaceHookMountAdapters(
  modules: ReturnType<typeof operationModuleLoader>
): Record<string, MountAdapter> {
  // The drawer's SSH hook. `connectionId` picks the arm the detection effect takes: a repo on
  // an SSH connection detects remote agents, one without it detects local agents.
  function sshStateAdapter(connectionId: string | undefined): MountAdapter {
    return (context) => {
      const useSsh = modules.load<
        typeof import('../../../tasks/use-mobile-tasks-workspace-ssh-state')
      >('mobile/src/tasks/use-mobile-tasks-workspace-ssh-state.tsx').useMobileTasksWorkspaceSshState

      const repo = { id: REPO, displayName: 'Repo', connectionId }

      const model = observableModel(context, {
        client: context.client,
        tasksSupported: true,
        runtimeTaskSettings: { disabledTuiAgents: [] },
        workspaceAgent: null,
        workspaceAgentOverridden: false,
        workspaceCreateDraft: { key: 'linear:1' },
        workspaceCreateRequiresSshConnection: false,
        workspaceCreateSshStatus: connectionId ? 'connected' : 'idle',
        workspaceCreateTargetConnectionId: connectionId,
        workspaceCreateTargetRepo: repo,
        workspaceDetectedAgentIds: null,
        workspaceSshState: null,
        workspaceSshConnecting: false
      })

      let actions: ReturnType<typeof useSsh>

      const hook = hookMount(() => {
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the recorder supplies only the members the hook reads.
        actions = useSsh(model as unknown as Parameters<typeof useSsh>[0])
      })

      let setup: unknown = 'unresolved'

      return {
        action(name) {
          if (name === 'mount') {
            return hook.mount()
          }

          if (name === 'connect') {
            return performHookAction(() => actions.connectWorkspaceSshRepo())
          }

          if (name === 'ensure-ready') {
            return actions.ensureWorkspaceSshReady(
              // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the hook reads only id, displayName and connectionId.
              repo as Parameters<typeof actions.ensureWorkspaceSshReady>[0]
            )
          }

          if (name === 'resolve-setup') {
            return actions
              .resolveCreateSetupDecision(
                // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: as above.
                repo as Parameters<typeof actions.resolveCreateSetupDecision>[0]
              )
              .then((value: unknown) => {
                setup = value

                return value
              })
          }

          throw new Error(`Unknown workspace ssh action: ${name}`)
        },
        state: () =>
          projectObservable({
            ssh: model.workspaceSshState,
            connecting: model.workspaceSshConnecting,
            detected: model.workspaceDetectedAgentIds,
            agent: model.workspaceAgent,
            setup
          }),
        dispose: hook.unmount
      }
    }
  }

  return {
    'tasks.workspace-source': (context) => {
      const useEffects = modules.load<
        typeof import('../../../tasks/use-mobile-tasks-workspace-source-effects')
      >(
        'mobile/src/tasks/use-mobile-tasks-workspace-source-effects.tsx'
      ).useMobileTasksWorkspaceSourceEffects

      const model = observableModel(context, {
        client: context.client,
        tasksSupported: true,
        workspaceCreateDraft: { key: 'linear:1' },
        workspaceCreateTargetRepo: { id: REPO, displayName: 'Repo' },
        workspaceSparseReloadKey: 0,
        workspaceBaseBranchQuery: '',
        showWorkspaceBaseBranchPicker: false,
        workspaceSparsePresets: [],
        workspaceSparsePresetsLoaded: false,
        workspaceSparsePresetsLoading: false,
        workspaceSparsePresetsError: '',
        workspaceSparsePresetId: null,
        workspaceSparseDraft: null,
        workspaceBaseBranchResults: [],
        workspaceBaseBranchLoading: false,
        workspaceBaseBranchError: ''
      })

      const hook = hookMount(() => {
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the recorder supplies only the members the hook reads.
        useEffects(model as unknown as Parameters<typeof useEffects>[0])
      })

      return {
        action(name, args) {
          if (name === 'mount') {
            return hook.mount()
          }

          if (name === 'branch-query') {
            model.showWorkspaceBaseBranchPicker = true
            model.workspaceBaseBranchQuery = String(args.query ?? 'main')

            return hook.update()
          }

          throw new Error(`Unknown workspace source action: ${name}`)
        },
        state: () =>
          projectObservable({
            presets: model.workspaceSparsePresets,
            presetsLoaded: model.workspaceSparsePresetsLoaded,
            presetsError: model.workspaceSparsePresetsError,
            branches: model.workspaceBaseBranchResults,
            branchError: model.workspaceBaseBranchError
          }),
        dispose: hook.unmount
      }
    },
    'tasks.workspace-sparse': (context) => {
      const useSparse = modules.load<
        typeof import('../../../tasks/use-mobile-tasks-workspace-sparse-actions')
      >(
        'mobile/src/tasks/use-mobile-tasks-workspace-sparse-actions.tsx'
      ).useMobileTasksWorkspaceSparseActions

      const model = observableModel(context, {
        client: context.client,
        tasksSupported: true,
        canSaveWorkspaceSparseDraft: true,
        workspaceCreateDraft: { key: 'linear:1' },
        workspaceCreateTargetConnectionId: 'ssh-1',
        workspaceCreateTargetRepo: { id: REPO, displayName: 'Repo' },
        workspaceSparseCheckoutAvailable: true,
        workspaceSparseDraft: { mode: 'new', name: 'docs', directoriesText: 'docs' },
        workspaceSparseDraftName: 'docs',
        workspaceSparseDraftParsed: { directories: ['docs'] },
        workspaceSparsePresetId: null,
        workspaceSparsePresets: [],
        workspaceSparsePresetsLoaded: false,
        workspaceSparsePresetsLoading: false,
        workspaceSparsePresetsError: '',
        workspaceSparseSaving: false,
        workspaceSshState: null,
        workspaceSshConnecting: false,
        showWorkspaceSparsePicker: false
      })

      let actions: ReturnType<typeof useSparse>

      const hook = hookMount(() => {
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the recorder supplies only the members the hook reads.
        actions = useSparse(model as unknown as Parameters<typeof useSparse>[0])
      })

      return {
        action(name) {
          if (name === 'mount') {
            return hook.mount()
          }

          if (name === 'save-preset') {
            return performHookAction(() => actions.saveWorkspaceSparsePreset())
          }

          throw new Error(`Unknown workspace sparse action: ${name}`)
        },
        state: () =>
          projectObservable({
            presets: model.workspaceSparsePresets,
            presetsError: model.workspaceSparsePresetsError,
            saving: model.workspaceSparseSaving,
            ssh: model.workspaceSshState
          }),
        dispose: hook.unmount
      }
    },
    'tasks.workspace-ssh': sshStateAdapter('ssh-1'),
    // The local arm: no connectionId, so the effect calls preflight.detectAgents.
    'tasks.workspace-ssh-local': sshStateAdapter(undefined)
  }
}
