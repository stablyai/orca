/**
 * Before anything is fenced: proof that every path a move rewrites names the same object on the
 * host, and that the host can take a WSL move at all (mover design, D1b-4). No files move, so a
 * path that resolves to something else in the distro would silently re-point the project.
 */
import { ORCAD_MIGRATION_LOCAL_WSL_SOURCE_RUNTIME_CAPABILITY } from '../../../shared/orcad-runtime-capabilities'
import { isDrvfsLinuxPath } from '../../../shared/wsl-paths'
import { wslUncPathToLinux } from './wsl-move-path-rewriter'

/** What git says about a folder, read once through the desktop's UNC path and once on the host. */
export type WslMovePathFacts = {
  /** The repository's common git dir, in the reader's own path form. */
  gitCommonDir: string | null
  head: string | null
  /** Worktree paths `git worktree list` reports, in the reader's own path form. */
  worktrees: readonly string[]
  /**
   * The contents of a one-off marker the desktop wrote into the folder for this preflight, as each
   * side reads it back; null when it could not be written or read. The only identity evidence a
   * folder outside git has.
   */
  marker: string | null
}

export type WslMovePreflightProbes = {
  desktop: (uncPath: string) => Promise<WslMovePathFacts | null>
  host: (linuxPath: string) => Promise<WslMovePathFacts | null>
}

export type WslMovePreflightRefusal =
  | 'missing-on-host'
  | 'unreadable-on-desktop'
  | 'different-object'
  | 'identity-unproven'
  | 'windows-drive'
  | 'not-in-distro'

export type WslMovePreflightResult = {
  refused: { path: string; reason: WslMovePreflightRefusal }[]
}

/** Each path is checked on both sides; the move goes ahead only when nothing is refused. */
export async function preflightWslMovePaths(
  uncPaths: readonly string[],
  distro: string,
  probes: WslMovePreflightProbes
): Promise<WslMovePreflightResult> {
  const refused: WslMovePreflightResult['refused'] = []
  for (const path of uncPaths) {
    const linux = wslUncPathToLinux(path, distro)
    if (linux === null) {
      refused.push({ path, reason: 'not-in-distro' })
      continue
    }
    // Windows folds the `/mnt/<drive>` tail of a UNC path case-insensitively (wsl-paths.ts).
    if (isDrvfsLinuxPath(linux.toLowerCase())) {
      refused.push({ path, reason: 'windows-drive' })
      continue
    }
    const [desktop, host] = await Promise.all([probes.desktop(path), probes.host(linux)])
    const reason =
      desktop === null
        ? 'unreadable-on-desktop'
        : host === null
          ? 'missing-on-host'
          : identityVerdict(desktop, host, distro)
    if (reason) {
      refused.push({ path, reason })
    }
  }
  return { refused }
}

/** Both readers must agree once the desktop's UNC answers are read as Linux paths. */
function identityVerdict(
  desktop: WslMovePathFacts,
  host: WslMovePathFacts,
  distro: string
): WslMovePreflightRefusal | null {
  if (desktop.marker !== null && host.marker !== null && desktop.marker !== host.marker) {
    return 'different-object'
  }
  if (desktop.gitCommonDir === null && host.gitCommonDir === null) {
    // Matching emptiness proves nothing: outside git, only the marker shows it is one folder.
    return desktop.marker !== null && desktop.marker === host.marker ? null : 'identity-unproven'
  }
  const asLinux = (value: string | null): string | null =>
    value === null ? null : (wslUncPathToLinux(value, distro) ?? value.replace(/\\/g, '/'))
  const sorted = (paths: readonly string[], map: (path: string) => string | null): string[] =>
    paths.map((path) => map(path) ?? path).sort()
  const same =
    asLinux(desktop.gitCommonDir) === host.gitCommonDir &&
    desktop.head === host.head &&
    JSON.stringify(sorted(desktop.worktrees, asLinux)) ===
      JSON.stringify(sorted(host.worktrees, (path) => path))
  return same ? null : 'different-object'
}

export type WslMoveHostReadiness = 'ready' | 'update-host'

/** A host without the WSL source kind runs an older template: relaunch it first (E1), never drop data. */
export function wslMoveHostReadiness(capabilities: readonly string[]): WslMoveHostReadiness {
  return capabilities.includes(ORCAD_MIGRATION_LOCAL_WSL_SOURCE_RUNTIME_CAPABILITY)
    ? 'ready'
    : 'update-host'
}
