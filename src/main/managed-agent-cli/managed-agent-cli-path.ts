import { isAbsolute, join, resolve } from 'node:path'
import { hasAppEnvironment } from '../../shared/app-lifecycle/app-environment'
import { isPathInsideOrEqual } from '../../shared/file-access/cross-platform-path'
import {
  UNVERIFIED_FS_PROBE,
  InventoryFsProbes
} from '../../shared/shell/command-resolution/inventory-fs-probes'
import { checkExecutableFile } from '../ipc/command-path/command-path-directory'
import { getProfileUserDataPath } from '../orca-profiles/profile-storage-paths'

export function getOrcaAgentRuntimeRoot(): string | undefined {
  return hasAppEnvironment() ? join(getProfileUserDataPath(), 'agent-runtimes') : undefined
}

export function isOrcaAgentRuntimePath(path: string): boolean {
  const root = /(?:^|[\\/])agent-runtimes(?:[\\/]|$)/i.test(path)
    ? getOrcaAgentRuntimeRoot()
    : undefined
  return root !== undefined && isPathInsideOrEqual(root, resolve(path))
}

export function createAgentRuntimeTargetCheck(probes: InventoryFsProbes) {
  const root = getOrcaAgentRuntimeRoot()
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

export async function canonicalLocalAgentProgram(
  path: string,
  signal: AbortSignal
): Promise<string | undefined> {
  if (!isAbsolute(path) || isOrcaAgentRuntimePath(path)) {
    return undefined
  }
  const probes = new InventoryFsProbes(signal)
  const target = await probes.realPath(path)
  return typeof target === 'string' &&
    isAbsolute(target) &&
    (await createAgentRuntimeTargetCheck(probes)(target)) === false &&
    (await checkExecutableFile(target, process.platform === 'win32', probes)) === 'executable'
    ? target
    : undefined
}
