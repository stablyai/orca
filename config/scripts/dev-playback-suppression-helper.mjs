import { execFileSync } from 'node:child_process'
import path from 'node:path'

const repoRoot = path.resolve(import.meta.dirname, '../..')

export function preparePlaybackSuppressionHelper() {
  const script =
    process.platform === 'darwin'
      ? 'build-playback-suppression-macos.mjs'
      : process.platform === 'win32'
        ? 'build-playback-suppression-windows.mjs'
        : null
  if (!script) {
    return
  }
  const args = [path.join(repoRoot, 'config', 'scripts', script)]
  if (process.platform === 'darwin') {
    args.push('--single-arch')
  }
  try {
    execFileSync(process.execPath, args, { stdio: 'inherit' })
  } catch (error) {
    // Why: missing native toolchains should disable muting in development,
    // not prevent the rest of Orca from starting.
    console.warn(`[orca-dev] playback suppression helper build failed: ${error?.message ?? error}`)
  }
}
