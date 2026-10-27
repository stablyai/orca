import { realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

// Use file URL conversion and realpath: hand-built URLs fail Windows, while symlinked argv differs from canonical import.meta.url and silently skips builders.
// Inject both seams so POSIX tests cover Windows and missing-path behavior.
export function isDirectInvocation(
  moduleUrl,
  scriptPath,
  { toFileUrl = pathToFileURL, realpath = realpathSync } = {}
) {
  if (!scriptPath) {
    return false
  }
  let resolved = scriptPath
  try {
    resolved = realpath(scriptPath)
  } catch {
    // A path that cannot be resolved cannot be this module; fall through to the literal compare.
  }
  return moduleUrl === toFileUrl(resolved).href
}
