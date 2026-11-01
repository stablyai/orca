import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { getAppEnvironment } from '../shared/app-environment'

const HISTORY_DIR_NAME = 'terminal-history'
const HISTORY_DIR_NAME_WSL = 'terminal-history-wsl'
// Tombstones survive a quit mid-removal so startup GC can finish them.
export const PENDING_DELETE_DIR_NAME = '.pending-delete'

export { hashWorktreeId } from './terminal-history-id'

export function getHistoryRoot(): string {
  return join(getAppEnvironment().getPath('userData'), HISTORY_DIR_NAME)
}

export function getHistoryRootWsl(distro: string): string {
  return join(getAppEnvironment().getPath('userData'), HISTORY_DIR_NAME_WSL, distro)
}

export function listWslHistoryRoots(): string[] {
  const wslRoot = join(getAppEnvironment().getPath('userData'), HISTORY_DIR_NAME_WSL)
  if (!existsSync(wslRoot)) {
    return []
  }
  try {
    return readdirSync(wslRoot).map((distro) => join(wslRoot, distro))
  } catch {
    return []
  }
}
