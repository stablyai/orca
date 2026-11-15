import { existsSync } from 'node:fs'
import { join } from 'node:path'

/** A file the build emits beside the main bundle; callers can sit one level down in chunks/. */
export function findBundledMainFile(fileName: string): string | undefined {
  return [join(__dirname, fileName), join(__dirname, '..', fileName)].find((candidate) =>
    existsSync(candidate)
  )
}
