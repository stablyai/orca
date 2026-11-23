/** Desktop main publishes managed-server actions for runtime RPC; headless hosts without a registry advertise none. */
import type {
  OrcadManagedPastLiveTerminals,
  OrcadManagedCancelStopResult,
  OrcadManagedDeployResult,
  OrcadManagedForgetResult,
  OrcadManagedRecoveryResult,
  OrcadManagedRollbackResult,
  OrcadManagedRuntimeStatus,
  OrcadManagedStopResult
} from '../../../../shared/remote-runtime/orcad-lifecycle/orcad-managed-runtime'

export type ManagedServerActions = {
  status: (selector: string) => Promise<OrcadManagedRuntimeStatus>
  update: (
    selector: string,
    force: boolean,
    pastLiveTerminals?: OrcadManagedPastLiveTerminals,
    /** With force, accepts that terminals orcad runs itself end when the census cannot count them. */
    endInProcessTerminals?: boolean
  ) => Promise<OrcadManagedDeployResult>
  rollback: (selector: string) => Promise<OrcadManagedRollbackResult>
  /** `acceptChangedState` restores the snapshot over state a rejected build changed. */
  recover: (selector: string, acceptChangedState?: boolean) => Promise<OrcadManagedRecoveryResult>
  stop: (selector: string) => Promise<OrcadManagedStopResult>
  cancelStop: (selector: string) => Promise<OrcadManagedCancelStopResult>
  forget: (selector: string) => Promise<OrcadManagedForgetResult>
  /** Forget only while another saved entry still manages the same server. */
  forgetRedundant: (selector: string) => Promise<OrcadManagedForgetResult>
}

let registered: ManagedServerActions | null = null

export function registerManagedServerActions(actions: ManagedServerActions | null): void {
  registered = actions
}

export function getManagedServerActions(): ManagedServerActions | null {
  return registered
}
