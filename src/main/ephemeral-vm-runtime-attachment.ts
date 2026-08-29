import {
  listEphemeralVmRuntimes,
  updateEphemeralVmRuntimeStatus
} from '../shared/ephemeral-vm-runtime-store'
import type { EphemeralVmRuntimeRecord } from '../shared/ephemeral-vm-runtimes'

export function attachEphemeralVmRuntimeToWorkspace(args: {
  userDataPath: string
  runtimeId: string
  workspaceId: string
}): EphemeralVmRuntimeRecord {
  const runtime = listEphemeralVmRuntimes(args.userDataPath).find(
    (entry) => entry.id === args.runtimeId
  )
  if (!runtime) {
    throw new Error(`Unknown ephemeral VM runtime: ${args.runtimeId}`)
  }
  if (['cleanup_pending', 'cleanup_failed', 'cleaned'].includes(runtime.status)) {
    throw new Error(`Cannot attach cleaned ephemeral VM runtime: ${args.runtimeId}`)
  }
  return updateEphemeralVmRuntimeStatus(args.userDataPath, args.runtimeId, {
    status: 'running',
    workspaceId: args.workspaceId
  })
}
