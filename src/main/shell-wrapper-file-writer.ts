/**
 * Writes a generated shell wrapper tree atomically, and says whether it worked.
 *
 * Why the boolean matters: the launch config points ZDOTDIR at the wrapper dir.
 * If a write failed — read-only FS, full disk, EACCES — the old code still
 * pointed ZDOTDIR at that dir, so zsh found no .zshrc there and the user
 * silently lost their entire configuration. Callers use the result to fall back
 * to an unwrapped shell instead.
 */
import { chmodSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export type ShellWrapperFile = readonly [path: string, content: string]

export function writeShellWrapperFiles(
  files: readonly ShellWrapperFile[],
  logPrefix: string
): boolean {
  try {
    for (const [path, content] of files) {
      mkdirSync(dirname(path), { recursive: true })
      // Why temp+rename: a shell reading the wrapper concurrently sees either
      // the old file or the new one, never a truncated prefix of the new one.
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
    console.error(`${logPrefix} Shell will launch unwrapped`)
    return false
  }
}
