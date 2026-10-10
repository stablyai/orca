import { execFileSync } from 'node:child_process'
import { statSync } from 'node:fs'
import path from 'node:path'

function mtimeMs(filePath) {
  try {
    return statSync(filePath).mtimeMs
  } catch {
    return 0
  }
}

/** Build the macOS process-info addon for `pnpm dev` when it is missing or older than its source. */
export function prepareDevProcInfoAddon(repoRoot) {
  const addonDir = path.join(repoRoot, 'native', 'proc-info-darwin')
  const addon = path.join(addonDir, '.build', 'release', 'orca-proc-info.node')
  if (process.platform !== 'darwin') {
    return
  }
  const sourceMtime = Math.max(
    ...['proc_info.c', 'proc_api_arguments.c', 'proc_api_arguments.h'].map((name) =>
      mtimeMs(path.join(addonDir, 'src', name))
    )
  )
  if (mtimeMs(addon) >= sourceMtime) {
    return
  }
  try {
    execFileSync(
      process.execPath,
      [path.join(repoRoot, 'config', 'scripts', 'build-proc-info-macos.mjs'), '--single-arch'],
      { stdio: 'inherit' }
    )
  } catch (error) {
    // Without clang, resize targeting keeps its existing ps fallback.
    console.warn(
      `[orca-dev] process-info addon build failed (ps stays in use): ${error?.message ?? error}`
    )
  }
}
