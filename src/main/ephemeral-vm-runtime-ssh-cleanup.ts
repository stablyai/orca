import { updateEphemeralVmRuntimeStatus } from '../shared/ephemeral-vm-runtime-store'
import type { EphemeralVmRuntimeRecord } from '../shared/ephemeral-vm-runtimes'

export async function removeEphemeralVmRuntimeSshTarget(args: {
  userDataPath: string
  runtime: EphemeralVmRuntimeRecord
  removeTarget: (targetId: string) => Promise<void>
}): Promise<EphemeralVmRuntimeRecord> {
  if (!args.runtime.sshTargetId) {
    return args.runtime
  }
  try {
    await args.removeTarget(args.runtime.sshTargetId)
  } catch {
    return updateEphemeralVmRuntimeStatus(args.userDataPath, args.runtime.id, {
      status: 'cleanup_failed',
      cleanupLastError: 'Failed to remove the hidden SSH target.'
    })
  }
  return updateEphemeralVmRuntimeStatus(args.userDataPath, args.runtime.id, {
    status: args.runtime.cleanupStatus === 'succeeded' ? 'cleaned' : args.runtime.status,
    cleanupLastError: null,
    connectionMode: null,
    sshTargetId: null
  })
}
