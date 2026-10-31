// Separate builds must not overwrite wrappers still used by surviving daemons.
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import type { ShellWrapperFile } from './shell-wrapper-file-writer'

export type ShellWrapperFileBuilder = (root: string) => readonly ShellWrapperFile[]

// A fixed root avoids a circular digest; it must be the only path-dependent template input.
const HASH_PROBE_ROOT = '/__orca_shell_wrapper_root__'
const ROOT_HASH_LENGTH = 16
// Keep the legacy suffix so old builds' self-reference guards still recognize these wrappers.
const WRAPPER_ROOT_LEAF = 'shell-ready'

export function resolveShellWrapperRoot(baseDir: string, build: ShellWrapperFileBuilder): string {
  const digest = createHash('sha256')
  for (const [path, content] of build(HASH_PROBE_ROOT)) {
    digest.update(path.slice(HASH_PROBE_ROOT.length))
    digest.update('\0')
    digest.update(content)
    digest.update('\0')
  }
  return join(baseDir, digest.digest('hex').slice(0, ROOT_HASH_LENGTH), WRAPPER_ROOT_LEAF)
}
