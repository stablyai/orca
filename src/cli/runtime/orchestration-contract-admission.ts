import type { RuntimeStatus } from '../../shared/runtime-types'
import { ORCHESTRATION_CONTRACT_RUNTIME_CAPABILITY } from '../../shared/protocol-version'
import { orchestrationMigrationData } from '../../shared/orchestration-rpc-contract'
import { RuntimeClientError } from './types'

export function assertOrchestrationContractCompatible(status: RuntimeStatus): void {
  if (!status.capabilities?.includes(ORCHESTRATION_CONTRACT_RUNTIME_CAPABILITY)) {
    throw new RuntimeClientError(
      'orchestration_migration_required',
      'The connected Orca runtime does not support the current orchestration contract. No effects were applied.',
      orchestrationMigrationData('runtime_capability_missing')
    )
  }
}
