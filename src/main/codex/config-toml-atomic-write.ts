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
  let renamed = false
  try {
    writeFileSync(temporaryPath, contents, {
      encoding: 'utf-8',
      mode: resolveCodexConfigTomlFileMode(writePath)
    })
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

/** Codex config.toml can carry `mcp_servers` env tokens: keep an existing file's mode, else owner-only. */
export function resolveCodexConfigTomlFileMode(configPath: string): number {
  try {
    return statSync(configPath).mode & 0o777
  } catch {
    return 0o600
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
