import { resolveEnvironment } from '../../shared/runtime-environment-store'
import { runtimeEnvironmentReconciliationAuthorityDigest } from '../../shared/runtime-environment-reconciliation-integrity'
import {
  getRuntimeSshAccess,
  type KnownRuntimeEnvironment
} from '../../shared/runtime-environments'
import { runTargetLifecycle } from '../ipc/ssh-target-lifecycle-queue'

export function runRuntimeEnvironmentReconciliationLifecycle<T>(
  userDataPath: string,
  registrations: readonly KnownRuntimeEnvironment[],
  operation: () => Promise<T>
): Promise<T> {
  const environments = [...new Set(registrations.map((entry) => entry.id))].sort()
  const targets = [
    ...new Set(
      registrations.flatMap((entry) => {
        const targetId =
          getRuntimeSshAccess(entry)?.sshTargetId ?? entry.pendingSshAccessOperation?.sshTargetId
        return targetId ? [targetId] : []
      })
    )
  ].sort()
  // Match link/unlink's environment-before-target order, including reversed participant selection.
  const keys = [...environments.map((id) => `runtime-ssh-access:${userDataPath}:${id}`), ...targets]
  const run = (index: number): Promise<T> => {
    if (index < keys.length) {
      return runTargetLifecycle(keys[index], () => run(index + 1))
    }
    for (const expected of registrations) {
      const current = resolveEnvironment(userDataPath, expected.id)
      if (
        current.pendingSshAccessOperation ||
        runtimeEnvironmentReconciliationAuthorityDigest(current) !==
          runtimeEnvironmentReconciliationAuthorityDigest(expected)
      ) {
        throw new Error(
          'Runtime registration changed or has pending SSH access; retry reconciliation.'
        )
      }
    }
    return operation()
  }
  return run(0)
}
