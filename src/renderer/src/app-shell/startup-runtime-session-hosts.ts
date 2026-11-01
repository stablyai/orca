import {
  toRuntimeExecutionHostId,
  toSshExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'
import { getRuntimeSshAccess } from '../../../shared/runtime-environments'

export async function listRuntimeSessionHostsForStartup(): Promise<{
  hostIds: ExecutionHostId[]
  sshHostIdByRuntimeHostId: Map<ExecutionHostId, ExecutionHostId>
}> {
  const sshHostIdByRuntimeHostId = new Map<ExecutionHostId, ExecutionHostId>()
  try {
    const hostIds = (await window.api.runtimeEnvironments.list()).map((environment) => {
      const hostId = toRuntimeExecutionHostId(environment.id)
      const sshTargetId = getRuntimeSshAccess(environment)?.sshTargetId
      if (sshTargetId) {
        sshHostIdByRuntimeHostId.set(hostId, toSshExecutionHostId(sshTargetId))
      }
      return hostId
    })
    return { hostIds, sshHostIdByRuntimeHostId }
  } catch (err) {
    console.warn('Failed to list runtime session hosts for startup:', err)
    return { hostIds: [], sshHostIdByRuntimeHostId }
  }
}
