/**
 * The managed-server actions the Managed servers settings run, published by the desktop main
 * process so runtime RPC can offer the same ones. A runtime with none registered (headless
 * `orca serve`) has no SSH registry to manage servers from, and does not advertise them.
 */
import type {
  OrcadManagedCancelStopResult,
  OrcadManagedDeployResult,
  OrcadManagedForgetResult,
  OrcadManagedRecoveryResult,
  OrcadManagedRollbackResult,
  OrcadManagedRuntimeStatus,
  OrcadManagedStopResult
} from '../../shared/orcad-managed-runtime'

export type ManagedServerActions = {
  status: (selector: string) => Promise<OrcadManagedRuntimeStatus>
  update: (selector: string, force: boolean) => Promise<OrcadManagedDeployResult>
  rollback: (selector: string) => Promise<OrcadManagedRollbackResult>
  /** `acceptChangedState` restores the snapshot over state a rejected build changed. */
  recover: (selector: string, acceptChangedState?: boolean) => Promise<OrcadManagedRecoveryResult>
  stop: (selector: string) => Promise<OrcadManagedStopResult>
  cancelStop: (selector: string) => Promise<OrcadManagedCancelStopResult>
  /** Unlinks a server whose host cannot answer, without stopping it there. */
  forget: (selector: string) => Promise<OrcadManagedForgetResult>
}

let registered: ManagedServerActions | null = null

export function registerManagedServerActions(actions: ManagedServerActions | null): void {
  registered = actions
}

export function getManagedServerActions(): ManagedServerActions | null {
  return registered
}
