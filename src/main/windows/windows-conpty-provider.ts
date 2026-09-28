import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { WINDOWS_CONPTY_FILES } from '../../shared/windows-conpty-release'

/** Validate both halves before Bun can load the provider or start its console host. */
export function resolveWindowsConptyProvider(directory: string, arch: string): string {
  if (arch !== 'x64' && arch !== 'arm64') {
    throw new Error(`Unsupported ConPTY architecture: ${arch}`)
  }
  const root = resolve(directory)
  for (const [filename, expected] of Object.entries(WINDOWS_CONPTY_FILES[arch])) {
    const actual = createHash('sha256')
      .update(readFileSync(join(root, filename)))
      .digest('hex')
    if (actual !== expected) {
      throw new Error(`Windows ConPTY identity mismatch: ${arch}/${filename}`)
    }
  }
  return join(root, 'conpty.dll')
}
