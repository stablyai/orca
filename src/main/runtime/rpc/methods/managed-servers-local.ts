import { defineMethod } from '../core'
import { ManagedServerSelector } from '../../../../shared/rpc-contract/host-management/managed-server-params'
import type {
  OrcadManagedForgetResult,
  OrcadManagedRefusal
} from '../../../../shared/remote-runtime/orcad-lifecycle/orcad-managed-runtime'
import { getSshTargetRegistryStore } from '../../../ssh/targets/ssh-target-registry'
import { isRuntimeOwnedSshTarget } from '../../../ssh/targets/ssh-target-runtime-ownership'

type ForgetImpl = (selector: string) => Promise<OrcadManagedForgetResult>

// Headless serve registers no managed-server actions, so `managedServer.forget` is unavailable there.
let wiredForget: ForgetImpl | null = null

export function wireManagedServerForgetLocal(impl: ForgetImpl | null): void {
  wiredForget = impl
}

const notWired: OrcadManagedRefusal = {
  outcome: 'refused',
  verdict: 'unverifiable',
  code: 'managed_server_unavailable',
  reason: 'This runtime does not offer `host forget`; only headless `orca serve` wires it.'
}

export const MANAGED_SERVER_LOCAL_METHODS = [
  defineMethod({
    name: 'managedServer.forgetLocal',
    permission: 'host-admin',
    params: ManagedServerSelector,
    handler: async (params) => {
      if (!wiredForget) {
        return notWired
      }
      const result = await wiredForget(params.selector)
      // The unlink only releases a fenced user target's claim; one this runtime created goes too.
      if (result.outcome === 'forgotten' && result.sshTargetId) {
        const store = getSshTargetRegistryStore()
        const target = store?.getTarget(result.sshTargetId)
        if (store && target && isRuntimeOwnedSshTarget(target)) {
          store.removeTarget(result.sshTargetId)
        }
      }
      return result
    }
  })
]
