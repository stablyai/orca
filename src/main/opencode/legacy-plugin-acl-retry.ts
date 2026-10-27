import { existsSync } from 'node:fs'
import { dirname } from 'node:path'
import { resolveCanonicalPluginWritePath } from '../../shared/opencode-plugin-atomic-write'
import { grantDirAcl, isPermissionError } from '../win32-utils'

// Chromium can reset userData's DACL after the startup grant; keep a per-write backstop.
export function writeLegacyOpenCodePluginWithAclRetry(
  pluginPath: string,
  writePlugin: () => void
): void {
  try {
    writePlugin()
  } catch (error) {
    if (process.platform === 'win32' && isPermissionError(error)) {
      try {
        let directory = dirname(resolveCanonicalPluginWritePath(pluginPath))
        // A denied mkdir needs a grant on its existing parent before it can inherit an ACL.
        while (!existsSync(directory) && dirname(directory) !== directory) {
          directory = dirname(directory)
        }
        grantDirAcl(directory)
        writePlugin()
        return
      } catch {
        // Preserve the original permission error if the grant or retry fails.
      }
    }
    throw error
  }
}
