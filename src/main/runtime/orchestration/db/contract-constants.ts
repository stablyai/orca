// v1.4.198 omits Run id; each remote attachment gets a stub home Run.
export const FEDERATED_STUB_HOME_RUN_ID_PREFIX = 'run_federated_'
export function federatedStubHomeRunId(dispatchId: string): string {
  return `${FEDERATED_STUB_HOME_RUN_ID_PREFIX}${dispatchId}`
}

export const LEGACY_CONTRACT_VERSION = 0

export const SCHEMA_VERSION = 46
