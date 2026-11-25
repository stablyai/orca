import { handleRuntimeEnvironmentChannel } from '../runtime-environment-channel-handling'
import { registerManagedServerActions } from '../../../runtime/hosts/management/managed-server-actions-registry'
import {
  createManagedOrcadActions,
  reclaimManagedOrcadStaleLock,
  restartManagedOrcad,
  type ManagedOrcadActionOptions
} from './managed-orcad-actions'
import { requiredString } from './orcad-runtime-lifecycle-handlers'

export function registerOrcadRuntimeMaintenanceHandlers(options: ManagedOrcadActionOptions): void {
  const actions = createManagedOrcadActions(options)
  // CLI runtime RPC uses these same managedServer actions.
  registerManagedServerActions(actions)
  handleRuntimeEnvironmentChannel(
    'runtimeEnvironments:updateOrcad',
    async (
      _event,
      args: {
        selector: string
        force?: boolean
        pastLiveTerminals?: { incumbentVersion?: unknown; uncounted?: unknown }
      }
    ) => {
      const incumbentVersion = args?.pastLiveTerminals?.incumbentVersion
      const pastLiveTerminals =
        args?.pastLiveTerminals &&
        (typeof incumbentVersion === 'string' || incumbentVersion === null)
          ? {
              incumbentVersion,
              ...(args.pastLiveTerminals.uncounted === true ? { uncounted: true as const } : {})
            }
          : undefined
      return actions.update(
        requiredString(args?.selector, 'Server'),
        args?.force === true,
        pastLiveTerminals
      )
    }
  )
  handleRuntimeEnvironmentChannel(
    'runtimeEnvironments:rollbackOrcad',
    async (_event, args: { selector: string }) =>
      actions.rollback(requiredString(args?.selector, 'Server'))
  )
  handleRuntimeEnvironmentChannel(
    'runtimeEnvironments:recoverOrcad',
    async (_event, args: { selector: string; acceptChangedState?: boolean }) =>
      actions.recover(requiredString(args?.selector, 'Server'), args?.acceptChangedState === true)
  )
  handleRuntimeEnvironmentChannel(
    'runtimeEnvironments:restartOrcad',
    async (_event, args: { selector: string }) =>
      restartManagedOrcad(options, requiredString(args?.selector, 'Server'))
  )
  handleRuntimeEnvironmentChannel(
    'runtimeEnvironments:reclaimOrcadStaleLock',
    async (_event, args: { selector: string; yes?: boolean; expectNonce?: string }) =>
      reclaimManagedOrcadStaleLock(
        options,
        requiredString(args?.selector, 'Server'),
        // A confirmation without the checked record's nonce could clear a lock written since.
        args?.yes === true
          ? { yes: true, expectNonce: requiredString(args.expectNonce, 'The checked lock') }
          : { yes: false }
      )
  )
  handleRuntimeEnvironmentChannel(
    'runtimeEnvironments:stopOrcad',
    async (_event, args: { selector: string }) =>
      actions.stop(requiredString(args?.selector, 'Server'))
  )
  handleRuntimeEnvironmentChannel(
    'runtimeEnvironments:cancelOrcadStop',
    async (_event, args: { selector: string }) =>
      actions.cancelStop(requiredString(args?.selector, 'Server'))
  )
  handleRuntimeEnvironmentChannel(
    'runtimeEnvironments:forgetOrcad',
    async (_event, args: { selector: string }) =>
      actions.forget(requiredString(args?.selector, 'Server'))
  )
}
