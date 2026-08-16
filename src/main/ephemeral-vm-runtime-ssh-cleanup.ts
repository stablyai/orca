import {
  listEphemeralVmRuntimes,
  updateEphemeralVmRuntimeStatus
} from '../shared/ephemeral-vm-runtime-store'
import type { EphemeralVmRuntimeRecord } from '../shared/ephemeral-vm-runtimes'

export async function removeEphemeralVmRuntimeSshTarget(args: {
  userDataPath: string
  runtime: EphemeralVmRuntimeRecord
  removeTarget: (targetId: string) => Promise<void>
}): Promise<EphemeralVmRuntimeRecord> {
  const current = getCurrentRuntime(args.userDataPath, args.runtime)
  if (!current.sshTargetId) {
    return finishCompletedCleanup(args.userDataPath, current)
  }
  try {
    await args.removeTarget(current.sshTargetId)
  } catch {
    const latest = getCurrentRuntime(args.userDataPath, current)
    if (!latest.sshTargetId) {
      return finishCompletedCleanup(args.userDataPath, latest)
    }
    return updateEphemeralVmRuntimeStatus(args.userDataPath, latest.id, {
      status: 'cleanup_failed',
      cleanupLastError: 'Failed to remove the hidden SSH target.'
    })
  }
  const latest = getCurrentRuntime(args.userDataPath, current)
  const status = latest.cleanupStatus === 'succeeded' ? 'cleaned' : latest.status
  return updateEphemeralVmRuntimeStatus(args.userDataPath, latest.id, {
    status,
    ...(status === 'cleaned' ? { cleanupLastError: null } : {}),
    connectionMode: null,
    sshTargetId: null
  })
}

function getCurrentRuntime(
  userDataPath: string,
  fallback: EphemeralVmRuntimeRecord
): EphemeralVmRuntimeRecord {
  return listEphemeralVmRuntimes(userDataPath).find((entry) => entry.id === fallback.id) ?? fallback
}

function finishCompletedCleanup(
  userDataPath: string,
  runtime: EphemeralVmRuntimeRecord
): EphemeralVmRuntimeRecord {
  if (runtime.cleanupStatus !== 'succeeded' || runtime.status === 'cleaned') {
    return runtime
  }
  return updateEphemeralVmRuntimeStatus(userDataPath, runtime.id, {
    status: 'cleaned',
    cleanupLastError: null,
    connectionMode: null,
    sshTargetId: null
  })
}
