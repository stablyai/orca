import { readFileSync } from 'node:fs'
import { join } from 'node:path'

function readCompiledOutputField(runtimeDir: string, field: 'version' | 'commit'): string | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(runtimeDir, '..', 'package.json'), 'utf8'))
    const value = parsed && typeof parsed === 'object' && field in parsed ? parsed[field] : null
    return typeof value === 'string' && value.length > 0 ? value : null
  } catch {
    return null
  }
}

// Node-mode CLI code cannot read the package metadata inside app.asar.
export function readOrcaCliVersion(runtimeDir = __dirname): string | null {
  return readCompiledOutputField(runtimeDir, 'version')
}

/** The commit the CLI was built from, stamped into the same package boundary. */
export function readOrcaCliBuildCommit(runtimeDir = __dirname): string | null {
  return readCompiledOutputField(runtimeDir, 'commit')
}
