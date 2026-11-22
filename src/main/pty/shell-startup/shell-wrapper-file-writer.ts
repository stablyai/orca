// Callers must launch unwrapped if any wrapper write fails.
import { chmodSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export type ShellWrapperFile = readonly [path: string, content: string]

export function writeShellWrapperFiles(
  files: readonly ShellWrapperFile[],
  logPrefix: string,
  consequence = 'Shell will launch unwrapped'
): boolean {
  try {
    for (const [path, content] of files) {
      mkdirSync(dirname(path), { recursive: true })
      // Rename keeps concurrent shell reads from seeing truncated wrappers.
      const temporaryPath = `${path}.orca-tmp-${process.pid}`
      try {
        writeFileSync(temporaryPath, content, 'utf8')
        chmodSync(temporaryPath, 0o644)
        renameSync(temporaryPath, path)
      } catch (error) {
        rmSync(temporaryPath, { force: true })
        throw error
      }
    }
    return true
  } catch (error) {
    const errorMessage =
      error instanceof Error
        ? `${error.message} (${(error as NodeJS.ErrnoException).code || 'unknown'})`
        : String(error)
    console.error(`${logPrefix} Failed to write shell wrapper files: ${errorMessage}`)
    console.error(`${logPrefix} ${consequence}`)
    return false
  }
}
