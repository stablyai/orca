import { join } from 'node:path'
import { runProcessSync } from './script-child-process.mjs'
import { relayWindowsProcessTreeAddonDefect } from './windows-process-tree-gyp-rebuild.mjs'

const root = join(import.meta.dirname, '../..')

function checkPreparedRuntime() {
  return runProcessSync({
    program: process.execPath,
    args: [join(root, 'config/scripts/ensure-native-runtime.mjs'), '--check-only'],
    cwd: root,
    timeoutMs: 30_000
  })
}

export function canReusePreparedRelayAddon({
  enabled = false,
  arch,
  addonPath,
  sourceRepaired,
  hostArch = process.arch,
  platform = process.platform,
  checkRuntime = checkPreparedRuntime
}) {
  if (!enabled || sourceRepaired !== false || platform !== 'win32' || arch !== hostArch) {
    return false
  }
  try {
    if (relayWindowsProcessTreeAddonDefect(addonPath, arch) !== null) {
      return false
    }
    const result = checkRuntime()
    return result.code === 0 && !result.timedOut && !result.outputTruncated
  } catch {
    return false
  }
}
