import { blockedWslDistroForPath } from '../wsl/filesystem/wsl-unc-access-gate'
import type { InactiveCodexHome } from './service/service-types'

export type ResolvedCodexManagedHome = { kind: 'ready'; homePath: string } | { kind: 'skip' }

/** A preview is no act on its distro: reading a stopped one's home would boot it (E9). */
export async function inactiveCodexHomeUnlessStopped(
  resolved: ResolvedCodexManagedHome
): Promise<InactiveCodexHome> {
  return resolved.kind === 'ready' && !(await blockedWslDistroForPath(resolved.homePath))
    ? { kind: 'ready', managedHomePath: resolved.homePath }
    : { kind: 'skip' }
}
