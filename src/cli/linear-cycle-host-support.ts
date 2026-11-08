import { LINEAR_CYCLE_WRITE_RUNTIME_CAPABILITY } from '../shared/task-source-runtime-capabilities'
import type { RuntimeStatus } from '../shared/runtime-types'
import { RuntimeClientError, type RuntimeClient } from './runtime-client'

export async function assertLinearCycleSupported(
  client: RuntimeClient,
  cycle: string | null | undefined
): Promise<void> {
  if (cycle === undefined) {
    return
  }
  const status = await client.call<RuntimeStatus>('status.get')
  if (!status.result.capabilities?.includes(LINEAR_CYCLE_WRITE_RUNTIME_CAPABILITY)) {
    throw new RuntimeClientError(
      'incompatible_runtime',
      'Update Orca on the execution host before using --cycle for Linear writes.'
    )
  }
}
