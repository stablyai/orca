import type {
  MachineActionResult,
  MachineProviderSnapshot
} from '../../../../shared/machine-inventory'
import { MachineProviderError } from '../../../../shared/machine-provider-protocol'
import { MACHINES_DISABLED, toMachineActionResult } from '../../../machines/machine-action-result'
import { MachineSelector, MachinesList } from '../../../../shared/rpc-contract/machine-params'
import { getMachineService } from '../../../machines/desktop-machine-service'
import type { MachineService } from '../../../machines/machine-service'
import { defineMethod, type RpcContext } from '../core'

// Composer-open freshness; a refresh inside it reuses the last list instead of re-running providers.
const LIST_MAX_AGE_MS = 30_000

// Create, archive and delete spend money or destroy data, so they stay desktop-local IPC.
function run<T>(action: (service: MachineService) => Promise<T>): Promise<MachineActionResult<T>> {
  const service = getMachineService()
  return service ? toMachineActionResult(() => action(service)) : Promise.resolve(MACHINES_DISABLED)
}

function callerLabel(ctx: RpcContext): string {
  const caller = ctx.caller
  return caller?.kind === 'paired-device'
    ? `device ${caller.deviceId}`
    : (caller?.kind ?? 'unknown')
}

async function listMachines(
  service: MachineService,
  providerKey: string | undefined,
  refresh: boolean
): Promise<MachineProviderSnapshot[]> {
  const snapshots = service.snapshots()
  const selected = providerKey
    ? snapshots.filter((snapshot) => snapshot.providerKey === providerKey)
    : snapshots
  if (providerKey && selected.length === 0) {
    throw new MachineProviderError('not-found', `No machine provider ${providerKey}.`)
  }
  if (!refresh) {
    return selected
  }
  return Promise.all(
    selected.map((snapshot) => service.list(snapshot.providerKey, { maxAgeMs: LIST_MAX_AGE_MS }))
  )
}

export const MACHINE_METHODS = [
  defineMethod({
    name: 'machines.list',
    permission: 'workspace',
    params: MachinesList,
    handler: ({ providerKey, refresh }) =>
      run((service) => listMachines(service, providerKey, refresh === true))
  }),
  defineMethod({
    name: 'machines.get',
    permission: 'workspace',
    params: MachineSelector,
    handler: ({ providerKey, machineId }) => run((service) => service.get(providerKey, machineId))
  }),
  // Wake and sleep run this host's already-consented provider, which any workspace caller could
  // do from a terminal anyway.
  defineMethod({
    name: 'machines.wake',
    permission: 'workspace',
    params: MachineSelector,
    handler: ({ providerKey, machineId }, ctx) => {
      console.info(`[machines] wake ${providerKey} ${machineId} by ${callerLabel(ctx)}`)
      return run((service) => service.wake(providerKey, machineId))
    }
  }),
  defineMethod({
    name: 'machines.sleep',
    permission: 'workspace',
    params: MachineSelector,
    handler: ({ providerKey, machineId }, ctx) => {
      console.info(`[machines] sleep ${providerKey} ${machineId} by ${callerLabel(ctx)}`)
      return run((service) => service.sleep(providerKey, machineId))
    }
  })
] as const
