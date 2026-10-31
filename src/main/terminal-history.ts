import { join, basename } from 'node:path'
import { mkdirSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import {
  dropInheritedOrcaFishHistory,
  fishHistorySessionName,
  isSafeFishHistorySession,
  resolveFishHistoryDir
} from './fish-history-session'
import { dropInheritedOrcaHistFile } from './worktree-history-file-path'
import { parseWslPath, toLinuxPath } from './wsl'
import { getHistoryRoot, getHistoryRootWsl } from './terminal-history-paths'
import { hashWorktreeId } from './terminal-history-id'

type ShellKind = 'zsh' | 'bash' | 'fish' | 'pwsh' | 'powershell' | 'cmd' | 'unknown'

export const MAX_HISTORY_META_BYTES = 32 * 1024

// Prefix matching accepts versioned shell names such as bash-5.2.
export function resolveShellKind(shellPath: string): ShellKind {
  const name = basename(shellPath).toLowerCase()
  if (name.startsWith('zsh')) {
    return 'zsh'
  }
  if (name.startsWith('bash')) {
    return 'bash'
  }
  if (name.startsWith('fish')) {
    return 'fish'
  }
  if (name === 'pwsh' || name === 'pwsh.exe') {
    return 'pwsh'
  }
  if (name === 'powershell' || name === 'powershell.exe') {
    return 'powershell'
  }
  if (name === 'cmd' || name === 'cmd.exe') {
    return 'cmd'
  }
  return 'unknown'
}

// Fish ignores HISTFILE; its history lives in a session-named file outside this tree.
function historyFilename(shell: ShellKind): string | null {
  switch (shell) {
    case 'zsh':
      return 'zsh_history'
    case 'bash':
      return 'bash_history'
    case 'fish':
    case 'pwsh':
    case 'powershell':
    case 'cmd':
    case 'unknown':
      return null
  }
}

export function ensureHistoryDir(worktreeHash: string, wslDistro?: string): string | null {
  try {
    const root = wslDistro ? getHistoryRootWsl(wslDistro) : getHistoryRoot()
    const dir = join(root, worktreeHash)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    return dir
  } catch (err) {
    console.warn(
      `[pty:history] Failed to create history directory: ${err instanceof Error ? err.message : String(err)}`
    )
    return null
  }
}

// Record the fish session and spawn-time data dir so deletion can find its out-of-tree history.
function writeMetaFile(
  dir: string,
  worktreeId: string,
  fish?: { session: string; historyDir?: string }
): void {
  try {
    const metaPath = join(dir, 'meta.json')
    const existing = existsSync(metaPath) ? readHistoryMeta(dir) : null
    if (
      existing &&
      (!fish ||
        (existing.fishSession === fish.session && existing.fishHistoryDir === fish.historyDir))
    ) {
      return
    }
    writeFileSync(
      metaPath,
      JSON.stringify({
        worktreeId,
        createdAt: existing?.createdAt ?? new Date().toISOString(),
        ...(fish ? { fishSession: fish.session } : {}),
        ...(fish?.historyDir ? { fishHistoryDir: fish.historyDir } : {}),
        ...(existing?.installedMigrationBlobs
          ? { installedMigrationBlobs: existing.installedMigrationBlobs }
          : {})
      }),
      { mode: 0o600 }
    )
  } catch {
    // A metadata failure must not prevent terminal startup.
  }
}

export type HistoryDirMeta = {
  worktreeId?: string
  createdAt?: string
  fishSession?: string
  /** Spawn-time directory; may differ from this process's environment. */
  fishHistoryDir?: string
  /** Installed migration hashes prevent duplicate prepends on retry. */
  installedMigrationBlobs?: InstalledMigrationHistoryBlob[]
}

export type InstalledMigrationHistoryBlob = { sha256: string; shell: string }

export function readHistoryMeta(dir: string): HistoryDirMeta | null {
  try {
    const metaPath = join(dir, 'meta.json')
    if (statSync(metaPath).size > MAX_HISTORY_META_BYTES) {
      return null
    }
    return parseHistoryMeta(dir, readFileSync(metaPath, 'utf-8'))
  } catch {
    return null
  }
}

export async function readHistoryMetaAsync(dir: string): Promise<HistoryDirMeta | null> {
  try {
    const metaPath = join(dir, 'meta.json')
    if ((await stat(metaPath)).size > MAX_HISTORY_META_BYTES) {
      return null
    }
    return parseHistoryMeta(dir, await readFile(metaPath, 'utf-8'))
  } catch {
    return null
  }
}

function parseHistoryMeta(dir: string, contents: string): HistoryDirMeta | null {
  try {
    const raw: unknown = JSON.parse(contents)
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return null
    }
    const record = raw as Record<string, unknown>
    // Do not let tampered metadata steer deletion to another session.
    const expectedFishSession = fishHistorySessionName(basename(dir).split('.')[0])
    const fishSession =
      isSafeFishHistorySession(record.fishSession) && record.fishSession === expectedFishSession
        ? record.fishSession
        : undefined
    const fishHistoryDir =
      fishSession && typeof record.fishHistoryDir === 'string' && record.fishHistoryDir
        ? record.fishHistoryDir
        : undefined
    return {
      ...(typeof record.worktreeId === 'string' ? { worktreeId: record.worktreeId } : {}),
      ...(typeof record.createdAt === 'string' ? { createdAt: record.createdAt } : {}),
      ...(fishSession ? { fishSession } : {}),
      ...(fishHistoryDir ? { fishHistoryDir } : {}),
      ...parseInstalledMigrationBlobs(record.installedMigrationBlobs)
    }
  } catch {
    return null
  }
}

function parseInstalledMigrationBlobs(
  value: unknown
): Pick<HistoryDirMeta, 'installedMigrationBlobs'> {
  if (!Array.isArray(value)) {
    return {}
  }
  const blobs = value.flatMap((entry: unknown) =>
    entry &&
    typeof entry === 'object' &&
    'sha256' in entry &&
    typeof entry.sha256 === 'string' &&
    'shell' in entry &&
    typeof entry.shell === 'string'
      ? [{ sha256: entry.sha256, shell: entry.shell }]
      : []
  )
  return blobs.length > 0 ? { installedMigrationBlobs: blobs } : {}
}

export type HistoryInjectionResult = {
  shell: ShellKind
  histFile: string | null
  /** Exported as fish_history. */
  fishSession: string | null
  /** Path as seen by the spawned shell, including WSL translation. */
  historyDir: string | null
}

export function injectHistoryEnv(
  spawnEnv: Record<string, string>,
  worktreeId: string,
  shellPath: string,
  cwd: string,
  options: { wslDistro?: string | null } = {}
): HistoryInjectionResult {
  // Nested Orca launches inherit this value; clear it before any early return to prevent history leaks.
  delete spawnEnv.ORCA_HISTFILE
  dropInheritedOrcaFishHistory(spawnEnv)
  dropInheritedOrcaHistFile(spawnEnv)

  const shell = resolveShellKind(shellPath)
  const result: HistoryInjectionResult = {
    shell,
    histFile: null,
    fishSession: null,
    historyDir: null
  }

  const filename = historyFilename(shell)
  if (!filename && shell !== 'fish') {
    return result
  }

  // Preserve caller-provided history settings after dropping inherited Orca values.
  if (shell === 'fish' ? spawnEnv.fish_history : spawnEnv.HISTFILE) {
    return result
  }

  const worktreeHash = hashWorktreeId(worktreeId)

  const wslInfo = process.platform === 'win32' ? parseWslPath(cwd) : null
  const wslDistro = wslInfo?.distro ?? options.wslDistro?.trim()
  const histDir = ensureHistoryDir(worktreeHash, wslDistro)
  if (!histDir) {
    return result
  }

  if (!filename) {
    // Fish history lives outside histDir; metadata links it to this worktree.
    const session = fishHistorySessionName(worktreeHash)
    // The PTY's spawn environment determines fish's data directory.
    writeMetaFile(histDir, worktreeId, { session, historyDir: resolveFishHistoryDir(spawnEnv) })
    spawnEnv.fish_history = session
    result.fishSession = session
    result.historyDir = histDir
    return result
  }

  writeMetaFile(histDir, worktreeId)

  const histFilePath = join(histDir, filename)

  spawnEnv.HISTFILE = wslDistro ? toLinuxPath(histFilePath) : histFilePath
  // Preserve the injected path across system zshrc's unconditional HISTFILE assignment.
  spawnEnv.ORCA_HISTFILE = spawnEnv.HISTFILE

  result.histFile = spawnEnv.HISTFILE
  result.historyDir = spawnEnv.HISTFILE.replace(/[/\\][^/\\]+$/, '')
  return result
}

/** WSL's outer executable hides the login shell, so carry both history knobs. */
export function injectWslFishHistoryEnv(
  spawnEnv: Record<string, string>,
  worktreeId: string,
  wslDistro: string
): string | null {
  // Drop inherited Orca sessions even when the caller did not run injectHistoryEnv first.
  dropInheritedOrcaFishHistory(spawnEnv)
  if (spawnEnv.fish_history) {
    return null
  }
  const worktreeHash = hashWorktreeId(worktreeId)
  const historyDir = ensureHistoryDir(worktreeHash, wslDistro)
  if (!historyDir) {
    return null
  }
  const session = fishHistorySessionName(worktreeHash)
  // Omit host historyDir: WSL cleanup must resolve the fish data path inside its distro.
  writeMetaFile(historyDir, worktreeId, { session })
  spawnEnv.fish_history = session
  return session
}

export function updateHistoryEnvForFallback(
  spawnEnv: Record<string, string>,
  fallbackShellPath: string,
  injected: HistoryInjectionResult
): void {
  if (injected.fishSession && spawnEnv.fish_history === injected.fishSession) {
    delete spawnEnv.fish_history
  }
  if (!injected.historyDir) {
    return
  }

  const newFilename = historyFilename(resolveShellKind(fallbackShellPath))
  if (!newFilename) {
    delete spawnEnv.HISTFILE
    delete spawnEnv.ORCA_HISTFILE
    return
  }
  spawnEnv.HISTFILE = `${injected.historyDir}/${newFilename}`
  spawnEnv.ORCA_HISTFILE = spawnEnv.HISTFILE
}

export function logHistoryInjection(worktreeId: string, result: HistoryInjectionResult): void {
  const truncatedId = worktreeId.length > 60 ? `${worktreeId.slice(0, 60)}...` : worktreeId
  console.log(
    `[pty:history] worktreeId=${truncatedId} shell=${result.shell} histFile=${result.histFile ?? 'none'} fishSession=${result.fishSession ?? 'none'}`
  )
}
