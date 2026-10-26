// No files move: prove rewritten paths identify the same objects before fencing anything.
import { ORCAD_MIGRATION_LOCAL_WSL_SOURCE_RUNTIME_CAPABILITY } from '../../../shared/orcad-runtime-capabilities'
import { isDrvfsLinuxPath } from '../../../shared/wsl-paths'
import { wslUncPathToLinux } from './wsl-move-path-rewriter'

/** Read once through desktop UNC paths and once on the host. */
export type WslMovePathFacts = {
  /** Reader-native path spelling. */
  gitCommonDir: string | null
  head: string | null
  /** Reader-native git worktree list paths. */
  worktrees: readonly string[]
  /** Matching marker bytes are the only non-git folder identity proof; null means unreadable/unwritable. */
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
    // Windows also folds the /mnt/<drive> tail case-insensitively.
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

function identityVerdict(
  desktop: WslMovePathFacts,
  host: WslMovePathFacts,
  distro: string
): WslMovePreflightRefusal | null {
  if (desktop.marker !== null && host.marker !== null && desktop.marker !== host.marker) {
    return 'different-object'
  }
  if (desktop.gitCommonDir === null && host.gitCommonDir === null) {
    // Outside git, matching absence proves nothing; require the marker.
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

/** Older host templates must update before accepting WSL-source moves. */
export function wslMoveHostReadiness(capabilities: readonly string[]): WslMoveHostReadiness {
  return capabilities.includes(ORCAD_MIGRATION_LOCAL_WSL_SOURCE_RUNTIME_CAPABILITY)
    ? 'ready'
    : 'update-host'
}
