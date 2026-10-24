import { existsSync } from 'node:fs'

// Why: WSLg bind-mounts this in every GUI-enabled WSL2 distro and nowhere else, so it is
// the narrowest marker for "this window is an RDP-projected surface, not a local one".
const WSLG_RUNTIME_MOUNT = '/mnt/wslg'

/** True when WSLg is projecting this process's windows onto the Windows desktop. */
export function isWslgSession(
  deps: { exists?: (path: string) => boolean; platform?: NodeJS.Platform } = {}
): boolean {
  if ((deps.platform ?? process.platform) !== 'linux') {
    return false
  }
  return (deps.exists ?? existsSync)(WSLG_RUNTIME_MOUNT)
}
