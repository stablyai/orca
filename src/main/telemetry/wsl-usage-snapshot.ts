// Pure aggregation for the daily `wsl_usage_snapshot` event. Inputs carry distro names only so
// distinct distros can be counted; nothing but buckets and booleans reaches the payload.
import type { Repo } from '../../shared/repo-types'
import type { ProjectExecutionRuntimeResolution } from '../../shared/project-execution-runtime'
import { isDrvfsLinuxPath, parseWslUncPath } from '../../shared/wsl-paths'
import {
  bucketWslUsageCount,
  type WslUsageSnapshotProps
} from '../../shared/telemetry-wsl-usage-event-schemas'

export type WslUsageProjectLocation = 'distro_fs' | 'windows_drive'

export type WslUsageProject = {
  location: WslUsageProjectLocation
  kind: 'git' | 'folder'
  /** Distro name, or null for "the default distro"; only ever counted. */
  distro: string | null
}

export type WslUsageDistro = {
  version: 1 | 2 | null
  state: 'running' | 'stopped'
}

export type WslUsageSnapshotInput = {
  /** Raw Lxss registrations (Docker's included); null when the registry could not be read. */
  registeredDistroCount: number | null
  /** User distros (Docker Desktop's excluded) with WSL version and running state. */
  userDistros: readonly WslUsageDistro[]
  wslPackageVersion: string | null
  wslAvailableCached: boolean | null
  projects: readonly WslUsageProject[]
  /** Of the Windows-drive WSL git repos, those with a linked worktree WSL Git made. */
  windowsDriveReposWithWslWorktrees: number
  wslHostsGateOpen: boolean
}

/** `2.4.13.0` → `2.4`; anything else is dropped rather than sent. */
export function toWslMajorMinor(version: string | null): string | null {
  const match = version?.trim().match(/^(\d{1,3})\.(\d{1,3})(?:\.|$)/)
  return match ? `${Number(match[1])}.${Number(match[2])}` : null
}

function runtimeWslDistro(resolution: ProjectExecutionRuntimeResolution | undefined): {
  wsl: boolean
  distro: string | null
} {
  if (resolution?.status === 'resolved') {
    return resolution.runtime.kind === 'wsl'
      ? { wsl: true, distro: resolution.runtime.distro }
      : { wsl: false, distro: null }
  }
  // A WSL choice whose distro is missing is still a WSL-backed project.
  if (resolution?.status === 'repair-required') {
    return { wsl: true, distro: resolution.repair.preferredRuntime.distro }
  }
  return { wsl: false, distro: null }
}

/** A project on this machine: in a distro when its path is a `\\wsl$` share, else a Windows drive run through WSL. */
export function classifyLocalWslProject(
  repo: Pick<Repo, 'path' | 'kind'>,
  resolution: ProjectExecutionRuntimeResolution | undefined
): WslUsageProject | null {
  const kind = repo.kind === 'folder' ? 'folder' : 'git'
  const unc = parseWslUncPath(repo.path)
  if (unc) {
    return { location: 'distro_fs', kind, distro: unc.distro }
  }
  const runtime = runtimeWslDistro(resolution)
  return runtime.wsl ? { location: 'windows_drive', kind, distro: runtime.distro } : null
}

/** A project on a WSL-distro host: its path is a Linux path, `/mnt/<x>` being a Windows drive. */
export function classifyWslHostProject(
  repo: Pick<Repo, 'path' | 'kind'>,
  distro: string
): WslUsageProject {
  return {
    location: isDrvfsLinuxPath(repo.path) ? 'windows_drive' : 'distro_fs',
    kind: repo.kind === 'folder' ? 'folder' : 'git',
    distro
  }
}

function count<T>(items: readonly T[], predicate: (item: T) => boolean): number {
  return items.reduce((total, item) => (predicate(item) ? total + 1 : total), 0)
}

export function buildWslUsageSnapshot(input: WslUsageSnapshotInput): WslUsageSnapshotProps {
  const { projects, userDistros } = input
  const version = toWslMajorMinor(input.wslPackageVersion)
  // WSL folds distro names case-insensitively; a null distro is "the default", one more key.
  const projectDistros = new Set(projects.map((project) => project.distro?.toLowerCase() ?? ''))
  return {
    wsl_installed:
      (input.registeredDistroCount ?? 0) > 0 ||
      version !== null ||
      input.wslAvailableCached === true,
    ...(version ? { wsl_version: version } : {}),
    distro_registry_readable: input.registeredDistroCount !== null,
    distros_installed: bucketWslUsageCount(userDistros.length),
    distros_running: bucketWslUsageCount(count(userDistros, (d) => d.state === 'running')),
    distros_wsl1: bucketWslUsageCount(count(userDistros, (d) => d.version === 1)),
    distros_wsl2: bucketWslUsageCount(count(userDistros, (d) => d.version === 2)),
    projects_wsl_total: bucketWslUsageCount(projects.length),
    projects_wsl_distro_fs: bucketWslUsageCount(count(projects, (p) => p.location === 'distro_fs')),
    projects_wsl_windows_drive: bucketWslUsageCount(
      count(projects, (p) => p.location === 'windows_drive')
    ),
    projects_wsl_git: bucketWslUsageCount(count(projects, (p) => p.kind === 'git')),
    projects_wsl_folder: bucketWslUsageCount(count(projects, (p) => p.kind === 'folder')),
    projects_wsl_windows_drive_wsl_worktrees: bucketWslUsageCount(
      input.windowsDriveReposWithWslWorktrees
    ),
    project_distros_used: bucketWslUsageCount(projectDistros.size),
    wsl_hosts_gate_open: input.wslHostsGateOpen
  }
}
