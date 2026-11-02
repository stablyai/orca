import type { MountAdapter } from '../recording-scenario'
import { hookMount, performHookAction } from '../hook-mount'
import { projectObservable } from '../observable-model'
import type { operationModuleLoader } from '../operation-module-loader'

const REPO = { id: 'repo-1', displayName: 'Repo' }

// Exclude the drawer’s native-storage repo hook; recordings cover only the declared SSH/agent/setup/capability paths.
export function newWorkspaceMountAdapters(
  modules: ReturnType<typeof operationModuleLoader>
): Record<string, MountAdapter> {
  function executionTargetAdapter(connectionId: string | null): MountAdapter {
    return ({ client }) => {
      const useTarget = modules.load<
        typeof import('../../../components/use-new-workspace-execution-target')
      >(
        'mobile/src/components/use-new-workspace-execution-target.ts'
      ).useNewWorkspaceExecutionTarget
      let state: ReturnType<typeof useTarget>
      let visible = true
      const hook = hookMount(() => {
        state = useTarget({ client, connectionId, visible })
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
          if (name === 'connect') {
            return performHookAction(() => state.connect())
          }
          throw new Error(`Unknown execution target action: ${name}`)
        },
        state: () =>
          projectObservable({
            gate: state?.sshGate,
            detected: state?.detectedAgentIds
          }),
        dispose: hook.unmount
      }
    }
  }

  return {
    'components.execution-target': executionTargetAdapter('ssh-1'),
    'components.execution-target-local': executionTargetAdapter(null),
    'components.setup-script': ({ client }) => {
      const useSetup = modules.load<
        typeof import('../../../components/use-new-workspace-setup-script')
      >('mobile/src/components/use-new-workspace-setup-script.ts').useNewWorkspaceSetupScript
      let state: ReturnType<typeof useSetup>
      const hook = hookMount(() => {
        state = useSetup({
          client,
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the hook reads only the repo's id.
          selectedRepo: REPO as Parameters<typeof useSetup>[0]['selectedRepo']
        })
      })
      return {
        action(name) {
          if (name === 'mount') {
            return hook.mount()
          }
          throw new Error(`Unknown setup script action: ${name}`)
        },
        state: () =>
          projectObservable({
            command: state?.setupCommand,
            source: state?.setupSource,
            trust: state?.setupTrust,
            runPolicy: state?.setupRunPolicy,
            advanced: state?.showAdvanced,
            run: state?.runSetup
          }),
        dispose: hook.unmount
      }
    },
    'components.codex-reset-capability': ({ client }) => {
      const read = modules.load<typeof import('../../../components/codex-reset-credit-capability')>(
        'mobile/src/components/codex-reset-credit-capability.ts'
      ).readCodexResetCreditCapability
      let supported: unknown = 'unprobed'
      return {
        action: () =>
          read(client).then((value: unknown) => {
            supported = value
            return value
          }),
        state: () => ({ supported }),
        dispose: () => {}
      }
    }
  }
}
