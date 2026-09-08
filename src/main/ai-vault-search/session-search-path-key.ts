import { normalizeRuntimePathForComparison } from '../../shared/cross-platform-path'
import { parseWslUncPath, toWindowsWslPath } from '../../shared/wsl-paths'

export function sessionSearchPathKey(cwd: string, transcriptPath?: string): string {
  if (cwd.startsWith('\\') && !cwd.startsWith('\\\\')) {
    cwd = cwd.replaceAll('\\', '/')
  }
  const wsl = transcriptPath ? parseWslUncPath(transcriptPath) : null
  return normalizeRuntimePathForComparison(
    wsl && cwd.startsWith('/') && !cwd.startsWith('//') ? toWindowsWslPath(cwd, wsl.distro) : cwd
  ).replace(/\/+$/, '')
}
