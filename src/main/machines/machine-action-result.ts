import type { MachineActionResult } from '../../shared/machine-inventory'
import { MachineProviderError } from '../../shared/machine-provider-protocol'

/** The one place IPC and runtime RPC turn a service call into a typed, code-carrying result. */
export async function toMachineActionResult<T>(
  action: () => Promise<T> | T
): Promise<MachineActionResult<T>> {
  try {
    return { ok: true, value: await action() }
  } catch (error) {
    return {
      ok: false,
      code: error instanceof MachineProviderError ? error.code : 'unavailable',
      message: error instanceof Error ? error.message : String(error)
    }
  }
}

export const MACHINES_DISABLED: MachineActionResult<never> = {
  ok: false,
  code: 'unsupported',
  message: 'Machines are not enabled.'
}
