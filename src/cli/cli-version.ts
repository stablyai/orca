import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isStandaloneCli } from './standalone-cli-mode'

// Node-mode CLI code cannot read the package metadata inside app.asar.
export function readOrcaCliVersion(runtimeDir = __dirname): string | null {
  // Why: the standalone package ships orca.cjs beside its own stamped package.json.
  const manifestPath = isStandaloneCli()
    ? join(runtimeDir, 'package.json')
    : join(runtimeDir, '..', 'package.json')
  try {
    const parsed: unknown = JSON.parse(readFileSync(manifestPath, 'utf8'))
    const version =
      typeof parsed === 'object' && parsed !== null && 'version' in parsed ? parsed.version : null
    return typeof version === 'string' && version.length > 0 ? version : null
  } catch {
    return null
  }
}
