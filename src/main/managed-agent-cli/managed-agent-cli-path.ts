import { join, resolve } from 'node:path'
import { hasAppEnvironment } from '../../shared/app-lifecycle/app-environment'
import { isPathInsideOrEqual } from '../../shared/file-access/cross-platform-path'
import {
  UNVERIFIED_FS_PROBE,
  type InventoryFsProbes
} from '../../shared/shell/command-resolution/inventory-fs-probes'
import { getProfileUserDataPath } from '../orca-profiles/profile-storage-paths'

export function isOrcaAgentRuntimePath(path: string): boolean {
  return (
    /(?:^|[\\/])agent-runtimes(?:[\\/]|$)/i.test(path) &&
    hasAppEnvironment() &&
    isPathInsideOrEqual(join(getProfileUserDataPath(), 'agent-runtimes'), resolve(path))
  )
}

export function createAgentRuntimeTargetCheck(probes: InventoryFsProbes) {
  const root = hasAppEnvironment() ? join(getProfileUserDataPath(), 'agent-runtimes') : undefined
  let canonicalRoot: ReturnType<InventoryFsProbes['realPath']> | undefined
  return async (target: string): Promise<boolean | typeof UNVERIFIED_FS_PROBE> => {
    if (!root) {
      return false
    }
    const realRoot = await (canonicalRoot ??= probes.realPath(root))
    return realRoot === UNVERIFIED_FS_PROBE
      ? realRoot
      : realRoot !== null &&
          (isOrcaAgentRuntimePath(target) || isPathInsideOrEqual(realRoot, target))
  }
}
