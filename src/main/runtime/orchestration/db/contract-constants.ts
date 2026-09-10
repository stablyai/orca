import {
  ORCHESTRATION_LEGACY_RUN_ID,
  ORCHESTRATION_UNBOUND_RUN_ID
} from '../../../../shared/orchestration-rpc-contract'
import { ORCHESTRATION_CONTRACT_VERSION } from '../../../../shared/protocol-version'

export const LEGACY_RUN_ID = ORCHESTRATION_LEGACY_RUN_ID
export const UNBOUND_RUN_ID = ORCHESTRATION_UNBOUND_RUN_ID

// Why: a v1.4.198 coordinator sends no Run id, so its remote workers file mail under a per-attachment stub Run.
export const FEDERATED_STUB_HOME_RUN_ID_PREFIX = 'run_federated_'
export function federatedStubHomeRunId(dispatchId: string): string {
  return `${FEDERATED_STUB_HOME_RUN_ID_PREFIX}${dispatchId}`
}

export const LEGACY_CONTRACT_VERSION = 0
export const CURRENT_CONTRACT_VERSION = ORCHESTRATION_CONTRACT_VERSION

// Upstream v31-v38 retain their published meanings; Maestro migrations continue at v39+.
export const SCHEMA_VERSION = 45
