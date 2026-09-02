import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Node-mode CLI code cannot read the package metadata inside app.asar.
export function readOrcaCliVersion(runtimeDir = __dirname): string | null {
  try {
    const parsed = JSON.parse(readFileSync(join(runtimeDir, '..', 'package.json'), 'utf8')) as {
      version?: unknown
    }
    return typeof parsed.version === 'string' && parsed.version.length > 0 ? parsed.version : null
  } catch {
    return null
  }
}
