import { dirname, isAbsolute, join, resolve } from 'node:path'
import { getAppEnvironment, hasAppEnvironment } from '../../shared/app-environment'
import {
  GUEST_TREE_KILL_RESOURCE_DIR,
  readGuestTreeKillArtifact,
  type GuestTreeKillArtifact,
  type GuestTreeKillPlatform
} from '../../shared/guest-tree-kill-artifacts'

export type { GuestTreeKillPlatform } from '../../shared/guest-tree-kill-artifacts'

/** A packaged daemon resolves only its own resource tree, including the relocated update-safe copy. */
export function resolveBundledGuestTreeKillArtifact(
  platform: GuestTreeKillPlatform
): GuestTreeKillArtifact | null {
  const environment = hasAppEnvironment() ? getAppEnvironment() : null
  const packaged = environment?.isPackaged() ?? false
  const hostProcess: NodeJS.Process & { resourcesPath?: string } = process
  const entry = process.argv[1] ?? ''
  if (!environment && !hostProcess.resourcesPath && !isAbsolute(entry)) {
    return null
  }
  const asar = /[\\/]app\.asar\.unpacked[\\/]/.exec(entry)
  const roots = environment
    ? [
        packaged
          ? (hostProcess.resourcesPath ?? environment.getAppPath())
          : join(environment.getAppPath(), 'resources')
      ]
    : hostProcess.resourcesPath
      ? [hostProcess.resourcesPath]
      : asar
        ? [entry.slice(0, asar.index)]
        : /[\\/]out[\\/]main[\\/]daemon-entry\.js$/.test(entry)
          ? [resolve(dirname(entry), '../../resources')]
          : [hostProcess.resourcesPath ?? dirname(entry)]
  for (const resources of roots) {
    if (!resources || !isAbsolute(resources)) {
      continue
    }
    try {
      return readGuestTreeKillArtifact(join(resources, GUEST_TREE_KILL_RESOURCE_DIR), platform)
    } catch {
      // Missing/corrupt bundled ownership code never authorizes a PATH or user-installed fallback.
    }
  }
  return null
}
