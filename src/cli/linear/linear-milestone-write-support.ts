import { LINEAR_ISSUE_MILESTONE_WRITE_RUNTIME_CAPABILITY } from '../../shared/work-items/task-source-runtime-capabilities'
import type { RuntimeClient } from '../runtime/client'
import { RuntimeClientError } from '../runtime/connection/types'

// Why refused rather than sent: an older host strips the unknown milestone param and saves the issue without it.
export async function assertLinearMilestoneWriteSupport(client: RuntimeClient): Promise<void> {
  const status = await client.getCliStatus()
  if (!status.result.runtime.reachable) {
    throw new RuntimeClientError(
      'runtime_unavailable',
      'Orca could not verify --milestone support on the execution host, so nothing was written. Wait for the execution host to become reachable and retry.'
    )
  }
  if (
    status.result.runtime.capabilities?.includes(
      LINEAR_ISSUE_MILESTONE_WRITE_RUNTIME_CAPABILITY
    ) !== true
  ) {
    throw new RuntimeClientError(
      'incompatible_runtime',
      'This Orca host does not support --milestone on Linear writes, and would silently save the issue without it. Nothing was written; update Orca on the execution host.'
    )
  }
}
