import { randomUUID } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import '../../filesystem/atomic-file-publication'
import { renameFileWithWindowsRetry } from '../../../shared/file-write/windows-retry-file-operations'
import { lockClaudeConfig, runSerializedForClaudeConfig } from './claude-global-config-lock'
import { parseWslUncPath } from '../../../shared/file-access/wsl-paths'
import { runWslProcess } from '../../wsl/execution/wsl-runner'
import type { ClaudeRuntimeAuthPreparation } from '../../claude-accounts/runtime-auth/runtime-auth-types'
import {
  resolveClaudeGlobalConfigFile,
  toClaudeTrustKey,
  type ClaudeTrustPathStyle
} from './claude-config-paths'

export { resolveClaudeGlobalConfigFile, toClaudeTrustKey, type ClaudeTrustPathStyle }

export type ClaudeFolderTrustOutcome =
  | 'granted'
  | 'unchanged'
  | 'missing-config'
  | 'locked'
  | 'unreadable'

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export type ClaudeGlobalConfigChange =
  | { kind: 'unchanged' }
  | { kind: 'refuse' }
  | { kind: 'changed'; config: Record<string, unknown> }

export function applyClaudeFolderTrust(
  config: Record<string, unknown>,
  folderKeys: readonly string[]
): ClaudeGlobalConfigChange {
  if (config.projects !== undefined && !isPlainObject(config.projects)) {
    return { kind: 'refuse' }
  }
  const projects: Record<string, unknown> = { ...config.projects }
  const alreadyTrusted = folderKeys.some((key) => {
    const entry = projects[key]
    return isPlainObject(entry) && entry.hasTrustDialogAccepted === true
  })
  if (alreadyTrusted) {
    return { kind: 'unchanged' }
  }
  for (const key of folderKeys) {
    const entry = projects[key]
    projects[key] = isPlainObject(entry)
      ? { ...entry, hasTrustDialogAccepted: true }
      : { hasTrustDialogAccepted: true }
  }
  return { kind: 'changed', config: { ...config, projects } }
}

function isMissingFileError(error: unknown): boolean {
  const code = error instanceof Error && 'code' in error ? error.code : undefined
  return code === 'ENOENT' || code === 'ENOTDIR'
}

type ConfigTarget = { kind: 'file'; path: string } | { kind: 'missing' } | { kind: 'unreadable' }

/** Resolve symlinks before replacement so the rename preserves the link. */
function resolveConfigTarget(configFile: string): ConfigTarget {
  try {
    const entry = lstatSync(configFile)
    const path = entry.isSymbolicLink() ? realpathSync(configFile) : configFile
    return statSync(path).isFile() ? { kind: 'file', path } : { kind: 'unreadable' }
  } catch (error) {
    return { kind: isMissingFileError(error) ? 'missing' : 'unreadable' }
  }
}

function readConfigAt(
  target: ConfigTarget
): { path: string; config: Record<string, unknown> } | 'missing-config' | 'unreadable' {
  if (target.kind === 'missing') {
    return 'missing-config'
  }
  if (target.kind === 'unreadable') {
    return 'unreadable'
  }
  const config = readConfigObject(target.path)
  return config ? { path: target.path, config } : 'unreadable'
}

function readConfigObject(target: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(target, 'utf-8'))
    return isPlainObject(parsed) ? parsed : null
  } catch {
    return null
  }
}

type ReplacementFile = { target: string; path: string }

/** Prepare the replacement with target permissions before writing config data. */
async function createReplacementFile(target: string): Promise<ReplacementFile> {
  const suffix = `.orca-trust-${randomUUID()}.tmp`
  const path = `${target}${suffix}`
  const guestFile = parseWslUncPath(target)
  try {
    if (guestFile) {
      // Copy modes in the guest: Windows exposes synthetic permissions for WSL UNC files.
      writeFileSync(path, '', { flag: 'wx' })
      const copied = await runWslProcess({
        distro: guestFile.distro,
        loginPath: 'none',
        program: 'chmod',
        args: [`--reference=${guestFile.linuxPath}`, '--', `${guestFile.linuxPath}${suffix}`]
      })
      if (copied.code !== 0) {
        throw new Error(`could not copy the guest mode of ${target}: ${copied.stderr.trim()}`)
      }
    } else {
      const mode = statSync(target).mode & 0o777
      writeFileSync(path, '', { flag: 'wx', mode })
      if (process.platform !== 'win32') {
        // Restore bits narrowed by umask.
        chmodSync(path, mode)
      }
    }
  } catch (error) {
    rmSync(path, { force: true })
    throw error
  }
  return { target, path }
}

function replaceConfig(replacement: ReplacementFile, config: Record<string, unknown>): void {
  // Reuse the prepared file so its permission bits survive.
  writeFileSync(replacement.path, `${JSON.stringify(config, null, 2)}\n`, {
    encoding: 'utf-8',
    flag: 'r+'
  })
  renameFileWithWindowsRetry(replacement.path, replacement.target)
}

export async function grantClaudeFolderTrust(args: {
  configFile: string
  folderKeys: readonly string[]
}): Promise<ClaudeFolderTrustOutcome> {
  const outcome = await updateClaudeGlobalConfig(args.configFile, (config) =>
    applyClaudeFolderTrust(config, args.folderKeys)
  )
  return outcome === 'updated' ? 'granted' : outcome
}

export type ClaudeGlobalConfigUpdateOutcome =
  | Exclude<ClaudeFolderTrustOutcome, 'granted'>
  | 'updated'

/** Keep change pure: it runs before locking and again against the latest config under the lock. */
export function updateClaudeGlobalConfig(
  configFile: string,
  change: (config: Record<string, unknown>) => ClaudeGlobalConfigChange
): Promise<ClaudeGlobalConfigUpdateOutcome> {
  return runSerializedForClaudeConfig(configFile, () =>
    updateClaudeGlobalConfigNow({ configFile, change })
  )
}

async function updateClaudeGlobalConfigNow(args: {
  configFile: string
  change: (config: Record<string, unknown>) => ClaudeGlobalConfigChange
}): Promise<ClaudeGlobalConfigUpdateOutcome> {
  const probe = readConfigAt(resolveConfigTarget(args.configFile))
  if (typeof probe === 'string') {
    return probe
  }
  const planned = args.change(probe.config).kind
  if (planned !== 'changed') {
    return planned === 'refuse' ? 'unreadable' : 'unchanged'
  }

  // Copy guest permissions before locking; hold the lock only for synchronous read through rename.
  const replacement = await createReplacementFile(probe.path)
  try {
    let release: () => Promise<void>
    try {
      release = await lockClaudeConfig(args.configFile)
    } catch {
      return 'locked'
    }
    try {
      // Stay synchronous so the auth writer cannot interleave and lose updates.
      const current = readConfigAt(resolveConfigTarget(args.configFile))
      if (typeof current === 'string') {
        return current
      }
      // A retargeted symlink invalidates the prepared permissions.
      if (current.path !== replacement.target) {
        return 'unreadable'
      }
      const change = args.change(current.config)
      if (change.kind === 'refuse') {
        return 'unreadable'
      }
      if (change.kind === 'unchanged') {
        return 'unchanged'
      }
      replaceConfig(replacement, change.config)
      return 'updated'
    } finally {
      await release().catch(() => {})
    }
  } finally {
    rmSync(replacement.path, { force: true })
  }
}

export function claudeTrustKeysForHostPath(
  workspacePath: string,
  keyStyle: ClaudeTrustPathStyle,
  toClaudePath: (hostPath: string) => string | null = (hostPath) => hostPath
): string[] {
  const forms = [resolve(workspacePath)]
  try {
    forms.push(realpathSync.native(workspacePath))
  } catch {
    // The resolved form alone still matches an unsymlinked path.
  }
  const keys = new Set<string>()
  for (const form of forms) {
    const claudePath = toClaudePath(form)
    if (claudePath) {
      keys.add(toClaudeTrustKey(claudePath, keyStyle))
    }
  }
  return [...keys]
}

export type ClaudeTrustConfigTarget = {
  configFile: string
  keyStyle: ClaudeTrustPathStyle
  /** Maps a host-native path to the path the Claude process sees (WSL UNC → Linux). */
  toClaudePath?: (hostPath: string) => string | null
}

export function resolveLocalClaudeTrustConfig(args: {
  workspacePath: string
  env: Record<string, string | undefined>
  claudeAuth: ClaudeRuntimeAuthPreparation | null
  wslDistro: string | null
}): ClaudeTrustConfigTarget | null {
  const { claudeAuth } = args
  if (claudeAuth?.runtime === 'wsl' || args.wslDistro || parseWslUncPath(args.workspacePath)) {
    // Without guest auth preparation, configDir may name the Windows host's file.
    if (
      claudeAuth?.runtime !== 'wsl' ||
      !claudeAuth.wslLinuxConfigDir ||
      !parseWslUncPath(args.workspacePath)
    ) {
      return null
    }
    const legacyFile = join(claudeAuth.configDir, '.config.json')
    return {
      configFile: existsSync(legacyFile)
        ? legacyFile
        : claudeAuth.envPatch.CLAUDE_CONFIG_DIR
          ? join(claudeAuth.configDir, '.claude.json')
          : join(dirname(claudeAuth.configDir), '.claude.json'),
      keyStyle: 'posix',
      toClaudePath: (hostPath) => parseWslUncPath(hostPath)?.linuxPath ?? null
    }
  }
  const style = process.platform === 'win32' ? 'win32' : 'posix'
  const homeDir = (style === 'win32' ? args.env.USERPROFILE : args.env.HOME) || homedir()
  return {
    configFile: resolveClaudeGlobalConfigFile({
      env: args.env,
      homeDir,
      style,
      exists: existsSync
    }),
    keyStyle: style
  }
}

export async function grantClaudeWorkspaceTrust(
  target: ClaudeTrustConfigTarget,
  workspacePath: string
): Promise<ClaudeFolderTrustOutcome> {
  const folderKeys = claudeTrustKeysForHostPath(workspacePath, target.keyStyle, target.toClaudePath)
  return folderKeys.length === 0
    ? 'unchanged'
    : grantClaudeFolderTrust({ configFile: target.configFile, folderKeys })
}
