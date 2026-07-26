import { createHash } from 'node:crypto'
import { join, basename } from 'node:path'
import { mkdirSync, existsSync, writeFileSync, rmSync } from 'node:fs'
import { app } from 'electron'
import { parseWslPath, toLinuxPath } from './wsl'
import {
  deleteWslWorktreeHistoryDirectories,
  runTerminalHistoryGarbageCollection
} from './terminal-history-gc'

// ─── Constants ─────────────────────────────────────────────────────

const HISTORY_DIR_NAME = 'terminal-history'
const HISTORY_DIR_NAME_WSL = 'terminal-history-wsl'

type ShellKind = 'zsh' | 'bash' | 'fish' | 'pwsh' | 'powershell' | 'cmd' | 'unknown'

let scheduledHistoryGcTimer: ReturnType<typeof setTimeout> | null = null
let historyGcRunning = false

// ─── Shell Detection ───────────────────────────────────────────────

/** Resolve the shell kind from a shell binary path.
 *  Uses basename + prefix matching to handle versioned names like `bash-5.2`
 *  and nix-store paths like `/nix/store/.../bin/zsh`. */
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

// ─── Hash & Path Helpers ───────────────────────────────────────────

/** First 16 hex chars of SHA-256 of the worktreeId. */
export function hashWorktreeId(worktreeId: string): string {
  return createHash('sha256').update(worktreeId).digest('hex').slice(0, 16)
}

/** Map shell kind to the filename used inside the history directory. */
function historyFilename(shell: ShellKind): string | null {
  switch (shell) {
    case 'zsh':
      return 'zsh_history'
    case 'bash':
      return 'bash_history'
    // Phase 2: fish and PowerShell use different mechanisms
    case 'fish':
    case 'pwsh':
    case 'powershell':
    case 'cmd':
    case 'unknown':
      return null
  }
}

// ─── Directory Management ──────────────────────────────────────────

function getHistoryRoot(): string {
  return join(app.getPath('userData'), HISTORY_DIR_NAME)
}

function getHistoryRootWsl(distro: string): string {
  return join(app.getPath('userData'), HISTORY_DIR_NAME_WSL, distro)
}

/** Ensure the history directory exists for a given worktree hash.
 *  Returns the directory path, or null if creation failed. */
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

/** Write meta.json alongside history files for debuggability. */
function writeMetaFile(dir: string, worktreeId: string): void {
  try {
    const metaPath = join(dir, 'meta.json')
    if (!existsSync(metaPath)) {
      writeFileSync(metaPath, JSON.stringify({ worktreeId, createdAt: new Date().toISOString() }), {
        mode: 0o600
      })
    }
  } catch {
    // Non-fatal — meta.json is purely for diagnostics.
  }
}

// ─── Environment Injection ─────────────────────────────────────────

export type HistoryInjectionResult = {
  shell: ShellKind
  histFile: string | null
}

/** Build shell-specific history env overrides for a PTY spawn.
 *  Returns the injection result for diagnostics logging.
 *
 *  Why this is the industry-standard approach: Ghostty, Kitty, and VS Code
 *  all use check-before-set for HISTFILE. The major zsh frameworks (oh-my-zsh,
 *  Prezto) guard their HISTFILE assignments, so env-var injection works for
 *  the vast majority of users (see design doc §9). */
export function injectHistoryEnv(
  spawnEnv: Record<string, string>,
  worktreeId: string,
  shellPath: string,
  cwd: string,
  options: { wslDistro?: string | null } = {}
): HistoryInjectionResult {
  const shell = resolveShellKind(shellPath)
  const result: HistoryInjectionResult = { shell, histFile: null }

  const filename = historyFilename(shell)
  if (!filename) {
    // Unknown shell or Phase 2 shell (fish, pwsh, cmd) — leave unchanged.
    return result
  }

  // Check-before-set: if the caller already provided HISTFILE, preserve it.
  // This follows the pattern used by Ghostty, Kitty, and VS Code (§6).
  if (spawnEnv.HISTFILE) {
    return result
  }

  const worktreeHash = hashWorktreeId(worktreeId)

  // WSL: store under a separate root keyed by distro, and convert the
  // HISTFILE path to a Linux-visible /mnt/... path for the inner shell.
  const wslInfo = process.platform === 'win32' ? parseWslPath(cwd) : null
  const wslDistro = wslInfo?.distro ?? options.wslDistro?.trim()
  const histDir = ensureHistoryDir(worktreeHash, wslDistro)
  if (!histDir) {
    // Directory creation failed — degrade gracefully to shared history.
    return result
  }

  writeMetaFile(histDir, worktreeId)

  const histFilePath = join(histDir, filename)

  // For WSL, convert the Windows path to a Linux-visible path.
  spawnEnv.HISTFILE = wslDistro ? toLinuxPath(histFilePath) : histFilePath

  result.histFile = spawnEnv.HISTFILE
  return result
}

/** Update HISTFILE in spawnEnv when shell fallback changes the shell kind.
 *  For example, if zsh fails and bash takes over, the HISTFILE should point
 *  to bash_history instead of zsh_history. */
export function updateHistFileForFallback(
  spawnEnv: Record<string, string>,
  fallbackShellPath: string
): void {
  if (!spawnEnv.HISTFILE) {
    return
  }

  const newShell = resolveShellKind(fallbackShellPath)
  const newFilename = historyFilename(newShell)
  if (!newFilename) {
    // Fallback to an unknown shell — remove HISTFILE override entirely
    // so the shell uses its own default.
    delete spawnEnv.HISTFILE
    return
  }

  // Replace the filename portion of the HISTFILE path.
  const dir = spawnEnv.HISTFILE.replace(/[/\\][^/\\]+$/, '')
  spawnEnv.HISTFILE = `${dir}/${newFilename}`
}

/** Log the history injection result for diagnostics. */
export function logHistoryInjection(worktreeId: string, result: HistoryInjectionResult): void {
  const truncatedId = worktreeId.length > 60 ? `${worktreeId.slice(0, 60)}...` : worktreeId
  console.log(
    `[pty:history] worktreeId=${truncatedId} shell=${result.shell} histFile=${result.histFile ?? 'none'}`
  )
}

// ─── Cleanup ───────────────────────────────────────────────────────

/** Delete the history directory for a removed worktree. Non-fatal. */
export function deleteWorktreeHistoryDir(worktreeId: string): void {
  const worktreeHash = hashWorktreeId(worktreeId)
  const dir = join(getHistoryRoot(), worktreeHash)
  try {
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true })
      console.log(`[pty:history] Deleted history for worktree ${worktreeId}`)
    }
  } catch (err) {
    console.warn(
      `[pty:history] Failed to delete history dir: ${err instanceof Error ? err.message : String(err)}`
    )
  }

  // Also clean up WSL directories if any exist.
  if (process.platform === 'win32') {
    try {
      const wslRoot = join(app.getPath('userData'), HISTORY_DIR_NAME_WSL)
      deleteWslWorktreeHistoryDirectories({ wslRoot, worktreeHash })
    } catch {
      // Non-fatal.
    }
  }
}

// ─── Garbage Collection ────────────────────────────────────────────

/** Run background GC to prune history directories for worktrees that are no
 *  longer in Orca's known live-worktree set. */
export function runHistoryGc(liveWorktreeIds: Set<string>): void {
  try {
    const wslRoot = join(app.getPath('userData'), HISTORY_DIR_NAME_WSL)
    const summary = runTerminalHistoryGarbageCollection({
      mainRoot: getHistoryRoot(),
      wslRoot,
      liveWorktreeIds
    })

    console.log(
      `[pty:history:gc] totalDirs=${summary.totalDirs} orphaned=${summary.orphaned} pruned=${summary.pruned} totalSizeKB=${summary.totalSizeKB}`
    )
  } catch (err) {
    console.warn(`[pty:history:gc] GC failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/** Schedule GC after a delay so it runs after workspace hydration completes.
 *  `getLiveWorktreeIds` should use already-known IDs, not probe repo paths. */
export function scheduleHistoryGc(getLiveWorktreeIds: () => Promise<Set<string>>): void {
  // Why: main-window services can reattach during reload/reactivation; one
  // pending/running disk GC is enough and avoids duplicate startup I/O.
  if (scheduledHistoryGcTimer !== null || historyGcRunning) {
    return
  }
  // Why 10s: avoids competing with startup-critical I/O while still running
  // early enough to clean up before the user notices disk usage (§7.6).
  scheduledHistoryGcTimer = setTimeout(async () => {
    scheduledHistoryGcTimer = null
    historyGcRunning = true
    try {
      const liveIds = await getLiveWorktreeIds()
      runHistoryGc(liveIds)
    } catch (err) {
      console.warn(
        `[pty:history:gc] Failed to enumerate live worktrees for GC: ${err instanceof Error ? err.message : String(err)}`
      )
    } finally {
      historyGcRunning = false
    }
  }, 10_000)
}
