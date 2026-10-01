/**
 * Which `rg` the relay spawns. The SSH deploy uploads Orca's own ripgrep to a version-keyed cache
 * and passes its path via `--ripgrep-path`; PATH `rg` (and then the git/readdir fallbacks) stays
 * the answer whenever that binary is absent or cannot launch on this host.
 */
import { existsSync, statSync } from 'node:fs'
import { delimiter, join, win32 } from 'node:path'
import {
  isRipgrepSpawnCwdUsable,
  isTransientRipgrepSpawnError
} from '../shared/ripgrep-process-availability'
import { relayLogLine } from './relay-diagnostic-log'

export const PATH_RIPGREP_COMMAND = 'rg'

/**
 * Absolute path to a PATH `rg` on Windows, or null when there is none.
 *
 * Why Windows only: CreateProcessW searches the spawn cwd -- the user's repo -- before PATH, so a
 * bare `rg` there runs a planted `rg.exe` from a cloned repository. POSIX `execvp` never consults
 * the cwd, so a bare name stays correct and free there.
 */
export function isDriveRootedWindowsPath(dir: string): boolean {
  // Why not path.isAbsolute: on Windows it accepts `\tools` and `/tools`, which are rooted but
  // carry no drive, so they resolve against whatever drive the process is on. The probe would
  // then validate `C:\tools\rg.exe` while the spawn, running with the user's repo as cwd,
  // executes `D:\tools\rg.exe` -- the same cwd-dependence this lookup exists to remove.
  const { root } = win32.parse(dir)
  return /^[A-Za-z]:[\\/]/.test(root) || root.startsWith('\\\\')
}

// Why only rg.exe, though libuv honours %PATHEXT%: `.bat`/`.cmd` shims are not spawnable without
// `shell: true`, and every ripgrep installer (winget, choco, scoop, cargo) lays down rg.exe.
function resolveWindowsPathRipgrep(): string | null {
  for (const entry of (process.env.PATH ?? '').split(delimiter)) {
    const dir = entry.replace(/^"|"$/g, '').trim()
    if (!dir || !isDriveRootedWindowsPath(dir)) {
      continue
    }
    const candidate = join(dir, 'rg.exe')
    try {
      if (statSync(candidate).isFile()) {
        return candidate
      }
    } catch {
      /* next entry */
    }
  }
  return null
}

let windowsPathRipgrep: string | null | undefined

let bundledRipgrepPath: string | null = null
// Why a back-off, not forever: Windows AV often locks a just-installed rg.exe for its first spawns.
const BUNDLED_RIPGREP_RETRY_MS = 60_000
let bundledRipgrepUnusableUntil = 0

export function configureRelayBundledRipgrep(path: string | undefined): void {
  bundledRipgrepPath = path ? path : null
  bundledRipgrepUnusableUntil = 0
}

/**
 * The host's PATH ripgrep, safe to spawn directly, or null when it has none. On Windows that is an
 * absolute path, because a bare name would resolve against the spawn cwd first.
 */
export function pathRipgrepCommand(): string | null {
  if (process.platform !== 'win32') {
    return PATH_RIPGREP_COMMAND
  }
  // Why the explicit undefined check and not `??=`: a miss resolves to null, which is nullish, so
  // `??=` would re-walk every PATH entry on each call -- and a miss is the expensive case, since
  // it stats every directory instead of stopping at the first hit.
  if (windowsPathRipgrep === undefined) {
    windowsPathRipgrep = resolveWindowsPathRipgrep()
  }
  return windowsPathRipgrep
}

/** Null means this host has no usable rg, so the caller falls back to git/readdir. */
export function resolveRelayRipgrepCommand(): string | null {
  // Why check existence per spawn: the deploy uploads rg after the relay starts, so it can appear mid-session.
  if (
    bundledRipgrepPath &&
    Date.now() >= bundledRipgrepUnusableUntil &&
    existsSync(bundledRipgrepPath)
  ) {
    return bundledRipgrepPath
  }
  return pathRipgrepCommand()
}

export function resetRelayRipgrepPathCacheForTests(): void {
  windowsPathRipgrep = undefined
}

/**
 * Called when `command` failed to launch. Resolves true when it was the bundled binary and the
 * caller should retry once on PATH `rg`; spawns skip the bundled binary for a back-off window.
 */
export async function retryRipgrepOnPathAfterLaunchFailure(
  command: string,
  cwd: string,
  error?: unknown
): Promise<boolean> {
  if (command === PATH_RIPGREP_COMMAND || command !== bundledRipgrepPath) {
    return false
  }
  // Why: fd/process pressure says nothing about the binary, so it must not disable it for the relay's life.
  if (isTransientRipgrepSpawnError(error)) {
    return false
  }
  // Why: spawn reports a missing cwd as ENOENT too; that says nothing about the binary.
  if (!(await isRipgrepSpawnCwdUsable(cwd))) {
    return false
  }
  // Why only while the file exists: a removed binary is re-checked per spawn anyway.
  if (existsSync(command) && Date.now() >= bundledRipgrepUnusableUntil) {
    bundledRipgrepUnusableUntil = Date.now() + BUNDLED_RIPGREP_RETRY_MS
    relayLogLine(`[relay] Bundled ripgrep at ${command} failed to launch; using rg from PATH`)
  }
  return true
}
