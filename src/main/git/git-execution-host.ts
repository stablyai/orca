import { parseWslUncPath } from '../../shared/wsl-paths'

/**
 * The host a git target names -- native, or a WSL distro.
 *
 * Why: several call sites derived this independently and two of them disagreed
 * on precedence -- the runner routes by cwd, while capability state preferred
 * the caller's `wslDistro` hint. A hint naming a different distro than the cwd
 * then filed capability results against a host that never ran the command.
 *
 * Routing follows the cwd, so identity does too: a WSL UNC cwd names the distro
 * that will run git, and the hint only applies when the cwd cannot name one.
 *
 * Why "names" rather than "runs": one route overrides the name, and it cannot be
 * decided here. A Windows-authored linked worktree with a drive-letter cwd runs
 * native git.exe even under a WSL hint, and only an async filesystem probe knows
 * that (`usesHostGitForWslLinkedWorktree` in ./wsl-linked-worktree-git-routing).
 * Callers on that path pass its answer as `usesHostGit` so the override still
 * resolves here instead of being compensated for outside.
 */

export type GitExecutionHost =
  | { kind: 'native' }
  | { kind: 'wsl'; distro: string; cwdLinuxPath: string | null }

export type GitExecutionHostTarget = {
  cwd?: string
  wslDistro?: string
  /** Result of the linked-worktree routing probe: git.exe on the Windows host, not in WSL. */
  usesHostGit?: boolean
}

/**
 * Platform-agnostic: this reports the host a target *names*. Callers that only
 * route on Windows apply that gate themselves, so a WSL-shaped target keeps one
 * identity across platforms and unit tests do not depend on the host OS.
 */
export function gitExecutionHostForTarget(target: GitExecutionHostTarget): GitExecutionHost {
  if (target.usesHostGit) {
    return { kind: 'native' }
  }
  const cwdWsl = target.cwd ? parseWslUncPath(target.cwd) : null
  const distro = cwdWsl?.distro ?? target.wslDistro
  if (!distro) {
    return { kind: 'native' }
  }
  // Why carry the parsed path: `resolveCommand` needs the guest-side cwd, and null
  // (rather than '') is what distinguishes "the hint named the host" from "the cwd did".
  return { kind: 'wsl', distro, cwdLinuxPath: cwdWsl?.linuxPath ?? null }
}

/**
 * Why fold case: Windows treats WSL distro names case-insensitively (see
 * `foldWslUncPathCaseInsensitiveParts`), so `\\wsl$\ubuntu` and
 * `\\wsl.localhost\Ubuntu` are one host. Two keys would mean two capability
 * caches re-probing the same distro. `GitExecutionHost.distro` stays verbatim
 * because that is what `wsl.exe -d` receives.
 */
export function gitExecutionHostKey(host: GitExecutionHost): string {
  return host.kind === 'wsl' ? `wsl:${host.distro.toLowerCase()}` : 'local'
}
