import { blockedWslDistroForPath } from '../wsl/wsl-unc-access-gate'
import type { InactiveCodexHome } from './service/service-types'

/** A preview is no act on its distro: reading a stopped one's home would boot it (E9). */
export async function inactiveCodexHomeUnlessStopped(
  resolved: { kind: 'ready'; homePath: string } | { kind: 'skip' }
): Promise<InactiveCodexHome> {
  return resolved.kind === 'ready' && !(await blockedWslDistroForPath(resolved.homePath))
    ? { kind: 'ready', managedHomePath: resolved.homePath }
    : { kind: 'skip' }
}
