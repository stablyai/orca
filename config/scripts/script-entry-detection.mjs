import { realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

/**
 * Whether this module was run as the entry script. Two ways to get this wrong, both of which end
 * with a builder exiting 0 having written nothing: `file://${path}` never matches on Windows,
 * where import.meta.url is `file:///C:/...`; and Node resolves symlinks in import.meta.url but not
 * in argv[1], so `node /tmp/...` against a /private/tmp realpath compares two different strings.
 * Both seams are injectable so win32 and a missing path can be exercised from a posix runner.
 */
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
