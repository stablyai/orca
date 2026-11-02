import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Node-mode CLI code cannot read the package metadata inside app.asar.
export function readOrcaCliVersion(runtimeDir = __dirname): string | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(runtimeDir, '..', 'package.json'), 'utf8'))
    const value =
      parsed && typeof parsed === 'object' && 'version' in parsed ? parsed.version : null
    return typeof value === 'string' && value.length > 0 ? value : null
  } catch {
    return null
  }
}
