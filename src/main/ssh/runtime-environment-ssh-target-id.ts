import { getRuntimeSshAccess } from '../../shared/runtime-environments'
import { readEnvironmentStore } from '../../shared/runtime-environment-store-file'

/** The SSH host a managed server is reached through, or null for any other runtime. */
export function getRuntimeEnvironmentSshTargetId(
  userDataPath: string,
  environmentId: string
): string | null {
  try {
    const environment = readEnvironmentStore(userDataPath).environments.find(
      (candidate) => candidate.id === environmentId
    )
    return environment ? (getRuntimeSshAccess(environment)?.sshTargetId ?? null) : null
  } catch {
    return null
  }
}
