import { handleRuntimeEnvironmentChannel } from '../runtime-environment-channel-handling'
import type {
  OrcadManagedConversionResult,
  OrcadManagedPendingMigrationRow
} from '../../../../shared/remote-runtime/orcad-lifecycle/orcad-managed-runtime'
import { listPendingManagedOrcadMigrations } from '../../../managed-server/lifecycle/orcad-managed-migration-status'
import { convertSshTargetToManagedOrcad } from '../../../managed-server/lifecycle/orcad-runtime-conversion'
import { conversionCollaborators } from '../../../managed-server/lifecycle/orcad-runtime-conversion-wiring'
import { requiredString } from './orcad-runtime-lifecycle-handlers'

export function registerOrcadRuntimeConversionHandlers(getUserDataPath: () => string): void {
  handleRuntimeEnvironmentChannel(
    'runtimeEnvironments:convertSshHostToManagedOrcad',
    (
      _event,
      args: { sshTargetId: string; name: string }
    ): Promise<OrcadManagedConversionResult> => {
      return convertSshTargetToManagedOrcad(getUserDataPath(), {
        sshTargetId: requiredString(args?.sshTargetId, 'SSH target'),
        name: requiredString(args?.name, 'Server name'),
        ...conversionCollaborators()
      })
    }
  )
  handleRuntimeEnvironmentChannel(
    'runtimeEnvironments:listPendingOrcadMigrations',
    (): OrcadManagedPendingMigrationRow[] => listPendingManagedOrcadMigrations(getUserDataPath())
  )
}
