/**
 * Windows drive paths as a WSL distro spells them. Each distro picks its own `[automount] root`
 * (`/mnt/` by default) and applies `wsl.conf` changes on its next start, so the guest resolves the
 * drive's mount directory itself at the moment of use; the host keeps no copy that can go stale.
 */
import { quotePosixShell } from '../../../shared/shell/launch/shell-argument-quoting'
import { parseWslUncPath } from '../../../shared/file-access/wsl-paths'
import { runWslProcess } from '../execution/wsl-runner'

const DRIVE_PATH = /^([A-Za-z]):[/\\](.*)$/

type DrivePath = { letter: string; tail: string }

function parseDrivePath(path: string): DrivePath | null {
  const match = DRIVE_PATH.exec(path)
  return match
    ? { letter: match[1].toLowerCase(), tail: match[2].replace(/\\/g, '/').replace(/\/+$/, '') }
    : null
}

function joinGuestDrivePath(root: string, tail: string): string {
  const base = root.endsWith('/') ? root.slice(0, -1) : root
  return tail ? `${base}/${tail}` : base || '/'
}

/** Shell words for host paths plus the lines that must run first; empty `prelude` when none is a drive path. */
export type WslGuestShellPaths = { prelude: string; words: string[] }

/**
 * `C:\src\app` becomes a word that expands to `<C: mount>/src/app` in the guest; other values, and
 * every value at `literalIndices` (task text), are quoted literally. The prelude exits with
 * `failureExitCode` when a drive has no readable mount, so a command never runs from a wrong directory.
 */
export function wslGuestShellPaths(
  paths: readonly string[],
  failureExitCode: number,
  literalIndices: ReadonlySet<number> = new Set()
): WslGuestShellPaths {
  const letters = new Set<string>()
  const words = paths.map((path, index) => {
    const drive = literalIndices.has(index) ? null : parseDrivePath(path)
    if (!drive) {
      return quotePosixShell(path)
    }
    letters.add(drive.letter)
    const root = `"\${orca_drive_${drive.letter}%/}"`
    return drive.tail ? `${root}${quotePosixShell(`/${drive.tail}`)}` : root
  })
  const prelude = [...letters]
    .map((letter) => {
      const name = `orca_drive_${letter}`
      return (
        `${name}=$(wslpath -u '${letter.toUpperCase()}:\\' 2>/dev/null) && case "$${name}" in /*) ;; *) false ;; esac || ` +
        `{ echo "Orca could not find drive ${letter.toUpperCase()}: in this WSL distro" >&2; exit ${Math.trunc(failureExitCode)}; }; `
      )
    })
    .join('')
  return { prelude, words }
}

/** A WSL UNC path as its Linux path; a literal `//wsl$/x` off Windows is an ordinary directory. */
export function guestUncPath(path: string): string {
  return (process.platform === 'win32' ? parseWslUncPath(path)?.linuxPath : null) ?? path
}

/** True when any value needs the guest to resolve a drive mount. */
export function hasWindowsDrivePath(paths: readonly string[]): boolean {
  return paths.some((path) => DRIVE_PATH.test(path))
}

/**
 * Concrete guest spellings for values that are data rather than shell words (path joins, JSON,
 * comparisons): drive paths ask the distro once per call, WSL UNC paths become their Linux paths,
 * and anything else is returned unchanged. Runs in `distro`, which the caller is already using.
 */
export async function resolveWslGuestPaths(
  distro: string,
  paths: readonly string[],
  signal?: AbortSignal
): Promise<string[]> {
  const unc = paths.map(guestUncPath)
  const letters = [...new Set(unc.flatMap((path) => parseDrivePath(path)?.letter ?? []))]
  if (letters.length === 0) {
    return unc
  }
  const { prelude, words } = wslGuestShellPaths(
    letters.map((letter) => `${letter}:\\`),
    1
  )
  const result = await runWslProcess({
    distro,
    script: `${prelude}printf '%s\\n' ${words.join(' ')}`,
    loginPath: 'none',
    timeoutMs: 10_000,
    maxOutputBytes: 16 * 1024,
    ...(signal ? { signal } : {})
  })
  signal?.throwIfAborted()
  const roots = result.stdout.replace(/\r?\n$/, '').split(/\r?\n/)
  if (
    result.code !== 0 ||
    result.timedOut ||
    roots.length !== letters.length ||
    roots.some((root) => !root.startsWith('/'))
  ) {
    throw new Error(`Orca could not find the Windows drive mount in WSL distro ${distro}.`)
  }
  const rootFor = new Map(letters.map((letter, index) => [letter, roots[index]]))
  return unc.map((path) => {
    const drive = parseDrivePath(path)
    return drive ? joinGuestDrivePath(rootFor.get(drive.letter)!, drive.tail) : path
  })
}

export async function resolveWslGuestPath(
  distro: string,
  path: string,
  signal?: AbortSignal
): Promise<string> {
  return (await resolveWslGuestPaths(distro, [path], signal))[0]
}
