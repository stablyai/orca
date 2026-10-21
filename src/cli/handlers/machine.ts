import type {
  MachineActionResult,
  MachineProviderSnapshot,
  MachineRecord
} from '../../shared/machine-inventory'
import type { CommandHandler, HandlerContext } from '../dispatch'
import { getOptionalStringFlag, getRequiredStringFlag } from '../flags'
import { printResult } from '../format'
import { RuntimeClientError, type RuntimeRpcSuccess } from '../runtime-client'

const UNSUPPORTED_MESSAGE =
  'This Orca runtime has no machine providers. Update Orca and enable the Machines experiment in the desktop app.'
// Wake polls a waking machine for up to 180 s; the RPC default would give up first.
const MUTATION_TIMEOUT_MS = 5 * 60_000

async function callMachines<T>(
  { client }: HandlerContext,
  method: string,
  params: Record<string, unknown>,
  timeoutMs?: number
): Promise<RuntimeRpcSuccess<T>> {
  let response: RuntimeRpcSuccess<MachineActionResult<T>>
  try {
    response = await client.call<MachineActionResult<T>>(
      method,
      params,
      timeoutMs ? { timeoutMs } : undefined
    )
  } catch (error) {
    if (error instanceof RuntimeClientError && error.code === 'method_not_found') {
      throw new RuntimeClientError('incompatible_runtime', UNSUPPORTED_MESSAGE)
    }
    throw error
  }
  const result = response.result
  if (!result.ok) {
    throw new RuntimeClientError(`machine_${result.code}`, result.message)
  }
  return { ...response, result: result.value }
}

function formatMachine(machine: MachineRecord): string {
  return [machine.id, machine.name, machine.state, machine.lifetime, machine.lastError ?? '']
    .filter(Boolean)
    .join('\t')
}

function formatSnapshots(snapshots: MachineProviderSnapshot[]): string {
  if (snapshots.length === 0) {
    return 'No machine providers. Install a plugin that contributes one.'
  }
  return snapshots
    .flatMap((snapshot) => [
      `${snapshot.name} (${snapshot.providerKey})${snapshot.lastFailure ? ` · ${snapshot.lastFailure.message}` : ''}`,
      ...snapshot.machines.map((machine) => `  ${formatMachine(machine)}`),
      ...snapshot.pendingCreates.map((pending) => `  (starting) ${pending.name}`)
    ])
    .join('\n')
}

/** The provider for an id, from the cache, so scripts need not repeat --provider. */
async function resolveTarget(
  context: HandlerContext
): Promise<{ providerKey: string; machineId: string }> {
  const machineId = getRequiredStringFlag(context.flags, 'machine-id')
  const provider = getOptionalStringFlag(context.flags, 'provider')
  if (provider) {
    return { providerKey: provider, machineId }
  }
  const { result } = await callMachines<MachineProviderSnapshot[]>(context, 'machines.list', {})
  const owners = result.filter((snapshot) =>
    snapshot.machines.some((machine) => machine.id === machineId)
  )
  if (owners.length !== 1) {
    throw new RuntimeClientError(
      'invalid_argument',
      owners.length === 0
        ? `No cached machine ${machineId}. Run \`orca machine ls --refresh\` or pass --provider.`
        : `Machine id ${machineId} exists in several providers; pass --provider.`
    )
  }
  return { providerKey: owners[0]!.providerKey, machineId }
}

function mutation(method: 'machines.wake' | 'machines.sleep'): CommandHandler {
  return async (context) => {
    const target = await resolveTarget(context)
    const response = await callMachines<MachineRecord>(context, method, target, MUTATION_TIMEOUT_MS)
    printResult(response, context.json, formatMachine)
  }
}

export const MACHINE_HANDLERS: Record<string, CommandHandler> = {
  'machine ls': async (context) => {
    const response = await callMachines<MachineProviderSnapshot[]>(context, 'machines.list', {
      providerKey: getOptionalStringFlag(context.flags, 'provider'),
      refresh: context.flags.get('refresh') === true
    })
    printResult(response, context.json, formatSnapshots)
  },
  'machine wake': mutation('machines.wake'),
  'machine sleep': mutation('machines.sleep')
}
