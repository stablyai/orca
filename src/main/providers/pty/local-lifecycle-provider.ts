import type { IPtyProvider } from './provider-contract'
import type { PtyProcessInspectionProvider } from './process-inspection'

/** Inventory and lifecycle operations are distinct from choosing the backend for a new launch. */
export type LocalPtyLifecycleProvider = Pick<
  IPtyProvider,
  | 'listProcesses'
  | 'shutdown'
  | 'probePtyLiveness'
  | 'supportsAgentSessionClaims'
  | 'supportsAgentSessionCreateOperations'
> &
  PtyProcessInspectionProvider
