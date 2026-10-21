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
import { dirname, join, posix, resolve, win32 } from 'node:path'
import { homedir } from 'node:os'
import { lock } from 'proper-lockfile'
import { renameFileWithWindowsRetry } from '../codex-accounts/fs-utils'
import { runKeyedSerializedOperation } from '../cli/keyed-promise-queue'
import { parseWslUncPath } from '../../shared/wsl-paths'
import { runWslProcess } from '../wsl/wsl-runner'
import type { ClaudeRuntimeAuthPreparation } from '../claude-accounts/runtime-auth/runtime-auth-types'

export type ClaudeTrustPathStyle = 'posix' | 'win32'

export type ClaudeFolderTrustOutcome =
  | 'granted'
  | 'unchanged'
  | 'missing-config'
  | 'locked'
  | 'unreadable'

type ClaudeConfigEnv = {
  CLAUDE_CONFIG_DIR?: string
  CLAUDE_CODE_CUSTOM_OAUTH_URL?: string
}

// Why: Orca must never break a lock — a held one means "skip and let Claude ask".
// Large enough that proper-lockfile never judges it stale, small enough that its
// half-stale refresh timer stays inside setTimeout's 32-bit range.
const NEVER_STALE_MS = 2 ** 30
const LOCK_RETRIES = { retries: 4, factor: 2, minTimeout: 50, maxTimeout: 250 }
// Why: concurrent updates in one process retry the file lock in lockstep, so a launch burst
// would lose most of them to `locked`; queue them so only Claude itself contends for the lock.
const updateQueueByConfigFile = new Map<string, Promise<void>>()

function pathApi(style: ClaudeTrustPathStyle): typeof posix {
  return style === 'win32' ? win32 : posix
}

/** Claude looks up NFC `path.normalize` output, with `/` separators on Windows. */
export function toClaudeTrustKey(folderPath: string, style: ClaudeTrustPathStyle): string {
  const normalized = pathApi(style).normalize(folderPath.normalize('NFC'))
  return style === 'win32' ? normalized.replaceAll('\\', '/') : normalized
}

/**
 * Mirrors Claude Code's global config lookup: a legacy `<configDir>/.config.json`
 * wins, otherwise `.claude.json` sits in `CLAUDE_CONFIG_DIR` or the home directory.
 */
export function resolveClaudeGlobalConfigFile(args: {
  env: ClaudeConfigEnv
  homeDir: string
  style: ClaudeTrustPathStyle
  exists: (filePath: string) => boolean
}): string {
  const { join } = pathApi(args.style)
  const legacyDir = (args.env.CLAUDE_CONFIG_DIR ?? join(args.homeDir, '.claude')).normalize('NFC')
  const legacyFile = join(legacyDir, '.config.json')
  if (args.exists(legacyFile)) {
    return legacyFile
  }
  const suffix = args.env.CLAUDE_CODE_CUSTOM_OAUTH_URL ? '-custom-oauth' : ''
  return join(args.env.CLAUDE_CONFIG_DIR || args.homeDir, `.claude${suffix}.json`)
}

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

/** Resolves a symlinked config to its target so the rename keeps the link intact. */
function resolveConfigTarget(configFile: string): ConfigTarget {
  try {
    const entry = lstatSync(configFile)
    const path = entry.isSymbolicLink() ? realpathSync(configFile) : configFile
    return statSync(path).isFile() ? { kind: 'file', path } : { kind: 'unreadable' }
  } catch (error) {
    return { kind: isMissingFileError(error) ? 'missing' : 'unreadable' }
  }
}

/** Reads the config behind `target`, or says why it cannot be rewritten. */
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

/**
 * Creates an empty file beside `target` that already has `target`'s permission bits, so
 * renaming it over `target` can never widen them.
 */
async function createReplacementFile(target: string): Promise<ReplacementFile> {
  const suffix = `.orca-trust-${randomUUID()}.tmp`
  const path = `${target}${suffix}`
  const guestFile = parseWslUncPath(target)
  try {
    if (guestFile) {
      // Why: Windows sees a synthetic 0o666 for a guest file and cannot set its bits, and the
      // guest gives a file made through \\wsl.localhost its default 0644; only the guest can copy them.
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
        // Why: umask may narrow the requested mode; the replacement must match the original exactly.
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
  // Why r+: reopening without create/truncate keeps the mode the replacement was given.
  writeFileSync(replacement.path, `${JSON.stringify(config, null, 2)}\n`, {
    encoding: 'utf-8',
    flag: 'r+'
  })
  renameFileWithWindowsRetry(replacement.path, replacement.target)
}

/** Sets `projects[<folder>].hasTrustDialogAccepted` in Claude's global config. */
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

/**
 * Orca's one writer of a Claude global config. Never creates the file, never breaks Claude's
 * lock, and never rewrites a file it could not read and parse. `change` must be pure: it runs
 * once to plan and again under the lock.
 */
export function updateClaudeGlobalConfig(
  configFile: string,
  change: (config: Record<string, unknown>) => ClaudeGlobalConfigChange
): Promise<ClaudeGlobalConfigUpdateOutcome> {
  return runKeyedSerializedOperation(updateQueueByConfigFile, configFile, () =>
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
  // Why: most launches need nothing, so skip Claude's lock unless a write is due.
  const planned = args.change(probe.config).kind
  if (planned !== 'changed') {
    return planned === 'refuse' ? 'unreadable' : 'unchanged'
  }

  // Why before the lock: a WSL guest's mode takes a guest process to copy, and Claude's
  // lock should stay held only for the synchronous read → rename below.
  const replacement = await createReplacementFile(probe.path)
  try {
    let release: () => Promise<void>
    try {
      release = await lock(args.configFile, {
        // Why: Claude locks the literal `<file>.lock`, not a realpath'd one.
        lockfilePath: `${args.configFile}.lock`,
        realpath: false,
        stale: NEVER_STALE_MS,
        retries: LOCK_RETRIES,
        onCompromised: () => {}
      })
    } catch {
      return 'locked'
    }
    try {
      // Why: read → rename stays synchronous so Orca's own synchronous auth writer to
      // this file cannot interleave and lose an update.
      const current = readConfigAt(resolveConfigTarget(args.configFile))
      if (typeof current === 'string') {
        return current
      }
      // Why: a link retargeted since the replacement copied its mode means Claude asks.
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
    // Why: a no-op after the rename; otherwise the unused replacement must not linger.
    rmSync(replacement.path, { force: true })
  }
}

/** Keys for `workspacePath` as Claude will see it: the given and realpath'd forms. */
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

/** The config file a local or WSL-guest Claude will read, or null when Orca cannot tell. */
export function resolveLocalClaudeTrustConfig(args: {
  workspacePath: string
  /** The final spawn env layered over this process's env. */
  env: Record<string, string | undefined>
  claudeAuth: ClaudeRuntimeAuthPreparation | null
  wslDistro: string | null
}): ClaudeTrustConfigTarget | null {
  const { claudeAuth } = args
  if (claudeAuth?.runtime === 'wsl' || args.wslDistro || parseWslUncPath(args.workspacePath)) {
    // Why: a WSL guest reads its own config, reachable only through the auth prep's UNC dir;
    // without a guest config dir, the prep's `configDir` is the Windows host's own file.
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

/** Grants trust for `workspacePath` in the config `target` names. */
export async function grantClaudeWorkspaceTrust(
  target: ClaudeTrustConfigTarget,
  workspacePath: string
): Promise<ClaudeFolderTrustOutcome> {
  const folderKeys = claudeTrustKeysForHostPath(workspacePath, target.keyStyle, target.toClaudePath)
  return folderKeys.length === 0
    ? 'unchanged'
    : grantClaudeFolderTrust({ configFile: target.configFile, folderKeys })
}
