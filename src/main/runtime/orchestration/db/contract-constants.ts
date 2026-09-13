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

// Schema versions: v2 'heartbeat'+last_heartbeat_at, v3 delivered_at, v4 task-creator terminal, v5 task_title/display_name, v6 pane identity, v7 lightweight Runs, v8 crash-safe Run deliveries, v9 durable question threads, v10 Dispatch capabilities, v11 durable mutation receipts, v12 composed worker state, v18 post-v6 version-skew repair, v19 adopted legacy Runs and compatibility receipts, v20 legacy question backfill, v21 legacy scheduler-loss provenance, v22 dispatch assignee lookup, v23 worker terminal resource ownership, v24 creator-incarnation authority, v25 active Dispatch handle lookup, v26 indexed mutation receipt capacity, v27 durable federation acknowledgments, v28 durable local mutation caller identity, v31 dispatch/resource identity links, v32 bounded worker-terminal recovery metadata, v33 durable mailbox pointer Enter state, v34 role-addressed mailbox deliveries, v35 mailbox delivery default and index-predicate repair, v36 dispatch mailbox consumer generation, v37 recorded dispatch creator identity, v39 structured session journal archives.
export const SCHEMA_VERSION = 40
