import { join, resolve } from 'node:path'
import { hasAppEnvironment } from '../../shared/app-lifecycle/app-environment'
import { isPathInsideOrEqual } from '../../shared/file-access/cross-platform-path'
import { getProfileUserDataPath } from '../orca-profiles/profile-storage-paths'

export function isOrcaAgentRuntimePath(path: string): boolean {
  return (
    /(?:^|[\\/])agent-runtimes(?:[\\/]|$)/i.test(path) &&
    hasAppEnvironment() &&
    isPathInsideOrEqual(join(getProfileUserDataPath(), 'agent-runtimes'), resolve(path))
  )
}
