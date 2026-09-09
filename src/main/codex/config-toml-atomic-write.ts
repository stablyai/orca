import { randomUUID } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { dirname, join } from 'node:path'
import { renameFileWithWindowsRetry } from '../codex-accounts/fs-utils'
import { writeRollingFileBackup } from '../rolling-file-backup'

export function writeTomlConfigAtomically(configPath: string, contents: string): void {
  const writePath = resolveTomlWritePath(configPath)
  const directory = dirname(writePath)
  mkdirSync(directory, { recursive: true })
  const temporaryPath = join(directory, `.${Date.now()}-${randomUUID()}.tmp`)
  const existingMode = existsSync(writePath) ? statSync(writePath).mode : undefined
  let renamed = false
  try {
    writeFileSync(temporaryPath, contents, { encoding: 'utf-8', mode: existingMode })
    if (existsSync(writePath)) {
      writeRollingFileBackup(writePath, `${writePath}.bak`)
    }
    renameFileWithWindowsRetry(temporaryPath, writePath)
    renamed = true
  } finally {
    if (!renamed && existsSync(temporaryPath)) {
      try {
        unlinkSync(temporaryPath)
      } catch {
        // Why: cleanup failure must not mask the write failure.
      }
    }
  }
}

function resolveTomlWritePath(configPath: string): string {
  let isSymlink = false
  try {
    isSymlink = lstatSync(configPath).isSymbolicLink()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error
    }
  }
  // Why: replacing the lexical path would destroy a dotfiles symlink; dangling links fail closed.
  return isSymlink ? realpathSync.native(configPath) : configPath
}
