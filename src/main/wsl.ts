import { execFile, execFileSync } from 'node:child_process'
import { parseWslUncPath, toWindowsWslPath } from '../shared/wsl-paths'

export { toWindowsWslPath } from '../shared/wsl-paths'

export type WslPathInfo = {
  distro: string
  linuxPath: string
}

/**
 * Detect if a Windows path is a WSL UNC path and extract the distro name
 * and equivalent Linux path.
 *
 * Why: Windows exposes WSL filesystems as UNC paths under \\wsl.localhost\<Distro>\...
 * (modern) or \\wsl$\<Distro>\... (legacy). When a repo lives on a WSL filesystem,
 * native Windows git.exe is either absent or painfully slow — all process spawning
 * must be routed through `wsl.exe -d <distro>` with Linux-native paths instead.
 */
export function parseWslPath(windowsPath: string): WslPathInfo | null {
  if (process.platform !== 'win32') {
    return null
  }

  return parseWslUncPath(windowsPath)
}

/** True when `path` is a WSL UNC path (see {@link parseWslPath}). */
export function isWslPath(path: string): boolean {
  return parseWslPath(path) !== null
}

/**
 * Test whether a WSL UNC path exists inside its distro, returning null when
 * the answer can't be determined.
 *
 * Why: Win32 fs.statSync against the WSL 9P filesystem (\\wsl.localhost\...)
 * is unreliable — it can report ENOENT for paths that exist on the Linux
 * side, which made opening a WSL worktree fail with "Working directory ...
 * does not exist". `wsl.exe -d <distro> test <flag>` asks the distro
 * directly, which is the authoritative answer. Returns null (rather than
 * false) when wsl.exe is unavailable or errors so callers can fall back to
 * another check instead of falsely rejecting a valid path.
 */
function testWslUncPath(uncPath: string, testFlag: '-d' | '-e'): boolean | null {
  if (process.platform !== 'win32') {
    return null
  }
  const info = parseWslUncPath(uncPath)
  if (!info) {
    return null
  }
  try {
    execFileSync('wsl.exe', ['-d', info.distro, '--', 'test', testFlag, info.linuxPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 5000
    })
    return true
  } catch (error) {
    // A non-zero exit (path missing) surfaces as an error with a numeric
    // `status`; treat that as a definitive "does not exist". Any other failure
    // (wsl.exe missing, distro not running, timeout) is inconclusive -> null.
    if (typeof (error as { status?: unknown })?.status === 'number') {
      return false
    }
    return null
  }
}

/** Directory-only existence check — used for cwd validation (worktree open, PTY spawn). */
export function wslUncDirectoryExists(uncPath: string): boolean | null {
  return testWslUncPath(uncPath, '-d')
}

/**
 * Async counterpart to {@link testWslUncPath}. Used off the main-process critical
 * path where blocking the event loop up to 5s per probe on `execFileSync` is
 * unacceptable (terminal-link resolution, add-project validation).
 */
async function testWslUncPathAsync(
  uncPath: string,
  testFlag: '-d' | '-e'
): Promise<boolean | null> {
  if (process.platform !== 'win32') {
    return null
  }
  const info = parseWslUncPath(uncPath)
  if (!info) {
    return null
  }
  try {
    await execFileUtf8('wsl.exe', ['-d', info.distro, '--', 'test', testFlag, info.linuxPath])
    return true
  } catch (error) {
    // Async execFile surfaces a non-zero exit as an Error with a numeric
    // `code` (the exit code); anything else (spawn failure, timeout) is
    // inconclusive -> null. Mirrors the `status`-based classification in
    // testWslUncPath for the sync execFileSync path.
    if (typeof (error as { code?: unknown })?.code === 'number') {
      return false
    }
    return null
  }
}

/**
 * Async directory-only existence check — the add-project WSL validation must not
 * block the main process on a slow/unavailable distro. Mirrors the sync
 * {@link wslUncDirectoryExists} semantics: only a definitive `false` rejects,
 * an inconclusive `null` lets the caller proceed.
 */
export async function wslUncDirectoryExistsAsync(uncPath: string): Promise<boolean | null> {
  return testWslUncPathAsync(uncPath, '-d')
}

/**
 * Async any-kind (file or directory) existence check — the terminal-link resolver
 * probes one unique path per link candidate, and the sync `execFileSync` version
 * blocked the main process event loop up to 5s per path (#8156).
 */
export async function wslUncPathExistsAsync(uncPath: string): Promise<boolean | null> {
  return testWslUncPathAsync(uncPath, '-e')
}

/**
 * Resolve the git top-level directory for a Linux path inside a WSL distro,
 * returning the Linux-native root, or null when the answer is inconclusive
 * (not a git repo, wsl.exe/git unavailable, spawn failure).
 *
 * Why: mirrors addLocalRepoFromPath's getGitRepoRoot resolution for WSL adds so a
 * nested or sub-directory pick persists as the repo root instead of failing later
 * git/worktree ops. Stays async (never blocks the main process) and uses an arg
 * array with `--` (no shell). Null is inconclusive-safe so callers fall back to
 * the picked path and the picker's retry story stays open.
 */
export async function resolveWslGitRepoRootAsync(
  distro: string,
  linuxPath: string
): Promise<string | null> {
  if (process.platform !== 'win32') {
    return null
  }
  try {
    const stdout = await execFileUtf8('wsl.exe', [
      '-d',
      distro,
      '--',
      'git',
      '-C',
      linuxPath,
      'rev-parse',
      '--show-toplevel'
    ])
    const root = stdout.trim()
    return root.startsWith('/') ? root : null
  } catch {
    return null
  }
}

/**
 * Convert a Windows path to a Linux path for commands that will execute inside WSL.
 * Returns the path unchanged if it is already POSIX-style.
 *
 * Why: WSL hook/setup environments may need both the worktree UNC path
 * (\\wsl.localhost\...) and regular Windows install paths (C:\Users\...)
 * translated before passing them to bash. Leaving drive paths untouched
 * breaks scripts that read ORCA_ROOT_PATH or similar env vars inside WSL.
 */
export function toLinuxPath(windowsPath: string): string {
  const info = parseWslPath(windowsPath)
  if (info) {
    return info.linuxPath
  }

  const driveMatch = windowsPath.match(/^([A-Za-z]):[/\\](.*)$/)
  if (!driveMatch) {
    return windowsPath
  }

  const driveLetter = driveMatch[1].toLowerCase()
  const rest = driveMatch[2].replace(/\\/g, '/')
  return `/mnt/${driveLetter}/${rest}`
}

// ─── WSL home directory resolution ──────────────────────────────────

const wslHomeCache = new Map<string, string>()
let wslDistroCache: string[] | null = null

function normalizeWslListOutput(output: string): string[] {
  // Why: wsl.exe can emit UTF-16-looking NUL bytes when inherited through
  // some Windows shells; strip them before line parsing.
  return output
    .replaceAll(String.fromCharCode(0), '')
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^\*\s*/, ''))
    .filter(Boolean)
}

function isUserWslDistro(distro: string): boolean {
  return !distro.toLowerCase().startsWith('docker-desktop')
}

/** List installed WSL distros (excluding Docker Desktop's internal ones), sync + process-lifetime cached. */
export function listWslDistros(): string[] {
  if (wslDistroCache) {
    return wslDistroCache
  }

  if (process.platform !== 'win32') {
    wslDistroCache = []
    return wslDistroCache
  }

  try {
    const output = execFileSync('wsl.exe', ['--list', '--quiet'], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 5000
    })
    wslDistroCache = normalizeWslListOutput(output).filter(isUserWslDistro)
    return wslDistroCache
  } catch {
    wslDistroCache = []
    return wslDistroCache
  }
}

/** Async counterpart to {@link listWslDistros}; pass `{ refresh: true }` to force a re-probe for the WSL picker's retry flow. */
export async function listWslDistrosAsync(options?: { refresh?: boolean }): Promise<string[]> {
  // Why: the distro cache is process-lifetime and failure-sticky; a picker whose
  // repair story is "add a distro, then retry" must force a fresh probe.
  if (options?.refresh) {
    wslDistroCache = null
  }
  if (wslDistroCache !== null) {
    return wslDistroCache
  }

  if (process.platform !== 'win32') {
    wslDistroCache = []
    return wslDistroCache
  }

  try {
    const output = await execFileUtf8('wsl.exe', ['--list', '--quiet'])
    wslDistroCache = normalizeWslListOutput(output).filter(isUserWslDistro)
    return wslDistroCache
  } catch {
    wslDistroCache = []
    return wslDistroCache
  }
}

/** True once the distro list has been probed this process, regardless of the result. */
export function hasCachedWslDistros(): boolean {
  return wslDistroCache !== null
}

/** Cached distro list without triggering a wsl.exe probe; null if not yet probed. */
export function getCachedWslDistros(): string[] | null {
  return wslDistroCache
}

/** First available distro, used as the implicit default when a project doesn't pin one. */
export function getDefaultWslDistro(): string | null {
  return listWslDistros()[0] ?? null
}

/**
 * Get the home directory for a WSL distro, returned as a Windows UNC path.
 * Result is cached per distro for the process lifetime.
 *
 * Why: worktrees for WSL repos are created under ~/orca/workspaces inside
 * the WSL filesystem, mirroring the Windows workspace layout. We need the
 * WSL user's $HOME to compute that path.
 */
export function getWslHome(distro: string): string | null {
  if (wslHomeCache.has(distro)) {
    return wslHomeCache.get(distro)!
  }

  try {
    const home = execFileSync('wsl.exe', ['-d', distro, '--', 'bash', '-c', 'echo $HOME'], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 5000
    }).trim()

    if (!home || !home.startsWith('/')) {
      return null
    }

    const uncPath = toWindowsWslPath(home, distro)
    wslHomeCache.set(distro, uncPath)
    return uncPath
  } catch {
    return null
  }
}

/** Async counterpart to {@link getWslHome}, for callers that must not block the main thread. */
export async function getWslHomeAsync(distro: string): Promise<string | null> {
  if (wslHomeCache.has(distro)) {
    return wslHomeCache.get(distro)!
  }

  try {
    const home = (
      await execFileUtf8('wsl.exe', ['-d', distro, '--', 'bash', '-c', 'echo $HOME'])
    ).trim()

    if (!home || !home.startsWith('/')) {
      return null
    }

    const uncPath = toWindowsWslPath(home, distro)
    wslHomeCache.set(distro, uncPath)
    return uncPath
  } catch {
    return null
  }
}

// Cached WSL availability check — evaluated once per process lifetime
let wslAvailableCache: boolean | null = null

/**
 * Check whether wsl.exe is available and functional on this Windows machine.
 * Result is cached for the process lifetime.
 */
export function isWslAvailable(): boolean {
  if (wslAvailableCache !== null) {
    return wslAvailableCache
  }

  if (process.platform !== 'win32') {
    wslAvailableCache = false
    return false
  }

  try {
    execFileSync('wsl.exe', ['--status'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 5000
    })
    wslAvailableCache = true
  } catch {
    wslAvailableCache = false
  }

  return wslAvailableCache
}

/**
 * Async counterpart to {@link isWslAvailable} for IPC handlers that must not
 * block the main thread on wsl.exe. Shares the same process-lifetime cache;
 * pass `{ refresh: true }` to force a re-probe past a sticky failure state.
 */
export async function isWslAvailableAsync(options?: { refresh?: boolean }): Promise<boolean> {
  if (options?.refresh) {
    wslAvailableCache = null
  }
  if (wslAvailableCache !== null) {
    return wslAvailableCache
  }

  if (process.platform !== 'win32') {
    wslAvailableCache = false
    return false
  }

  try {
    await execFileUtf8('wsl.exe', ['--status'])
    wslAvailableCache = true
  } catch {
    wslAvailableCache = false
  }

  return wslAvailableCache
}

/** True once wsl.exe availability has been probed this process, regardless of the result. */
export function hasCachedWslAvailability(): boolean {
  return wslAvailableCache !== null
}

/** Cached availability without triggering a wsl.exe probe; null if not yet probed. */
export function getCachedWslAvailability(): boolean | null {
  return wslAvailableCache
}

/** Clears all process-lifetime WSL caches (home/distro/availability) so tests start from a known state. */
export function _resetWslCachesForTests(): void {
  wslHomeCache.clear()
  wslDistroCache = null
  wslAvailableCache = null
}

/** Seeds the distro/availability caches directly, bypassing wsl.exe, for test setup. */
export function _setWslCachesForTests(args: {
  available?: boolean | null
  distros?: string[] | null
}): void {
  wslAvailableCache = args.available ?? null
  wslDistroCache = args.distros ?? null
}

function execFileUtf8(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { encoding: 'utf-8', timeout: 5000 }, (error, stdout) => {
      if (error) {
        reject(error)
        return
      }
      resolve(stdout)
    })
  })
}
