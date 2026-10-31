// Windows-only daily usage; gather registry/WSL state only while transmission is enabled. Reuse confirmed running distros, otherwise share one probe when user distros exist.
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Store } from '../persistence'
import type { GlobalSettings } from '../../shared/global-settings-types'
import { getRepoExecutionHostId, parseExecutionHostId } from '../../shared/execution-host'
import { listEnvironments } from '../../shared/runtime-environment-store'
import { isWslHostRuntimeEnvironment } from '../../shared/runtime-environments'
import { resolveLocalWorkspaceRuntime } from '../local-project-runtime-resolution'
import { getCachedWslAvailability } from '../wsl-availability'
import { getCachedWslDistros } from '../wsl'
import { listConfirmedRunningWslDistros } from '../wsl-background-distro-gate'
import { filterUserWslDistros } from '../wsl-distro-list-output'
import { peekConfirmedRunningWslDistros } from '../wsl-running-distro-cache'
import { loadWindowsNativeRegistry, WINDOWS_REG_SZ } from '../windows-native-registry'
import { readWslDistroRegistrations } from '../wsl/wsl-distro-registry-id'
import { listWslHostDistros } from '../wsl/wsl-host-distro-list'
import {
  wslHostsAppliedMovedProjects,
  wslHostsAppliedPolicyState,
  wslHostsGateOpen,
  wslHostsGateState
} from '../wsl/wsl-host-gate'
import { isForeignLink, readWorktreeLinks } from '../git/worktree-prune-guard'
import { isTelemetryEnabled, track } from './client'
import {
  buildWslUsageSnapshot,
  classifyLocalWslProject,
  classifyWslHostProject,
  type WslUsageProject,
  type WslUsageSnapshotInput
} from './wsl-usage-snapshot'

export const WSL_USAGE_SNAPSHOT_INTERVAL_MS = 24 * 60 * 60 * 1000
// Hourly ticks compare time only; gathering stays at most daily.
const RECHECK_MS = 60 * 60 * 1000
const STAMP_FILE = 'wsl-usage-telemetry.json'
const WSL_MSI_KEY = 'SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Lxss\\MSI'

/** The WSL package version the MSI installer records; null for inbox/Store WSL or no addon. */
function readWslPackageVersion(): string | null {
  try {
    const registry = loadWindowsNativeRegistry()
    const entry = Object.entries(registry.getRegistryKey(registry.HK.LM, WSL_MSI_KEY) ?? {}).find(
      ([name]) => name.toLowerCase() === 'version'
    )?.[1]
    return entry?.type === WINDOWS_REG_SZ && typeof entry.value === 'string' ? entry.value : null
  } catch {
    return null
  }
}

export type WslUsageStore = Pick<Store, 'getRepos' | 'getProjects'> & {
  getSettings: () => Partial<Pick<GlobalSettings, 'localWindowsRuntimeDefault'>>
}

export function collectWslProjects(
  store: WslUsageStore,
  gateOpen: boolean,
  readHostDistros: () => Map<string, string>,
  defaultDistro: string | null
): WslUsageProject[] {
  const projects: WslUsageProject[] = []
  let wslHostDistroByEnvironment: Map<string, string> | null = null
  for (const repo of store.getRepos()) {
    const host = parseExecutionHostId(getRepoExecutionHostId(repo))
    if (!host || host.kind === 'local') {
      const project = classifyLocalWslProject(
        repo,
        resolveLocalWorkspaceRuntime(store, repo, repo.path)
      )
      if (project) {
        // Resolve null distro to the default so distinct counts do not invent another distro.
        projects.push({ ...project, distro: project.distro ?? defaultDistro })
      }
      continue
    }
    // Gated-off WSL hosts are never listed or reached, so they don't count as usage either.
    if (host.kind !== 'runtime' || !gateOpen) {
      continue
    }
    wslHostDistroByEnvironment ??= readHostDistros()
    const distro = wslHostDistroByEnvironment.get(host.environmentId)
    if (distro) {
      projects.push(classifyWslHostProject(repo, distro))
    }
  }
  return projects
}

/**
 * Windows-drive WSL git repos with a linked worktree whose link is a Linux path (WSL Git made it).
 * File reads only, one folder per such repo; no Git is spawned, so a repo whose `.git` is a file
 * (bare, or itself a linked worktree) reads as having none.
 */
export async function countWindowsDriveReposWithWslWorktrees(
  store: WslUsageStore
): Promise<number> {
  let total = 0
  for (const repo of store.getRepos()) {
    const host = parseExecutionHostId(getRepoExecutionHostId(repo))
    if (host && host.kind !== 'local') {
      continue
    }
    const project = classifyLocalWslProject(
      repo,
      resolveLocalWorkspaceRuntime(store, repo, repo.path)
    )
    if (project?.location !== 'windows_drive' || project.kind !== 'git') {
      continue
    }
    const links = await readWorktreeLinks(join(repo.path, '.git', 'worktrees'))
    // As Windows Git would read it: a POSIX link, not a `//server/share` one.
    if (links.some(({ link }) => isForeignLink(link, false))) {
      total += 1
    }
  }
  return total
}

function readWslHostDistros(userDataPath: string): Map<string, string> {
  try {
    return new Map(
      listEnvironments(userDataPath)
        .filter(isWslHostRuntimeEnvironment)
        .map((environment) => [environment.id, environment.orcadDeployment.distro])
    )
  } catch {
    return new Map()
  }
}

/** Reuse a confirmed running list; otherwise one shared probe, and none when no user distro exists. */
export async function listRunningDistrosForSnapshot(
  registrations: readonly { distro: string }[] | null,
  peek: () => readonly string[] | null = peekConfirmedRunningWslDistros,
  probe: () => Promise<string[]> = listConfirmedRunningWslDistros
): Promise<string[]> {
  const cached = peek()
  if (cached) {
    return [...cached]
  }
  const userNames = filterUserWslDistros((registrations ?? []).map(({ distro }) => distro))
  return userNames.length > 0 ? probe() : []
}

export async function gatherWslUsageSnapshotInput(
  store: WslUsageStore,
  userDataPath: string
): Promise<WslUsageSnapshotInput> {
  const gateOpen = wslHostsGateOpen()
  const registrations = await readWslDistroRegistrations()
  const userDistros = await listWslHostDistros({
    readRegistrations: async () => registrations,
    listRunning: () => listRunningDistrosForSnapshot(registrations)
  })
  return {
    registeredDistroCount: registrations?.length ?? null,
    userDistros,
    wslPackageVersion: readWslPackageVersion(),
    wslAvailableCached: getCachedWslAvailability(),
    projects: collectWslProjects(
      store,
      gateOpen,
      () => readWslHostDistros(userDataPath),
      getCachedWslDistros()?.[0] ?? null
    ),
    windowsDriveReposWithWslWorktrees: await countWindowsDriveReposWithWslWorktrees(store),
    wslHostsGateOpen: gateOpen,
    wslHostsGateState: wslHostsGateState(),
    wslHostsPolicy: wslHostsAppliedPolicyState(),
    wslHostsMovedProjects: wslHostsAppliedMovedProjects()
  }
}

async function readLastSentAt(file: string): Promise<number | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(file, 'utf8'))
    const value =
      parsed && typeof parsed === 'object' && 'lastSentAt' in parsed ? parsed.lastSentAt : null
    return typeof value === 'number' && Number.isFinite(value) ? value : null
  } catch {
    return null
  }
}

export type WslUsageReporterDeps = {
  now?: () => number
  platform?: NodeJS.Platform
  telemetryEnabled?: () => boolean
  gather?: () => Promise<WslUsageSnapshotInput>
}

export class WslUsageReporter {
  private lastSentAt: number | null | undefined
  private running = false
  private timer: ReturnType<typeof setInterval> | null = null
  private readonly stampFile: string

  constructor(
    private readonly store: WslUsageStore,
    private readonly userDataPath: string,
    private readonly deps: WslUsageReporterDeps = {}
  ) {
    this.stampFile = join(userDataPath, STAMP_FILE)
  }

  start(): void {
    if ((this.deps.platform ?? process.platform) !== 'win32' || this.timer) {
      return
    }
    void this.reportIfDue()
    this.timer = setInterval(() => void this.reportIfDue(), RECHECK_MS)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  /** Returns whether a snapshot was sent. Never throws. */
  async reportIfDue(): Promise<boolean> {
    if ((this.deps.platform ?? process.platform) !== 'win32' || this.running) {
      return false
    }
    // Gate before gathering so opted-out installs pay no registry/wsl.exe read.
    if (!(this.deps.telemetryEnabled ?? isTelemetryEnabled)()) {
      return false
    }
    this.running = true
    try {
      const now = (this.deps.now ?? Date.now)()
      if (this.lastSentAt === undefined) {
        this.lastSentAt = await readLastSentAt(this.stampFile)
      }
      // A stamp from the future (clock moved back) counts as due rather than blocking for months.
      const elapsed = this.lastSentAt === null ? Infinity : now - this.lastSentAt
      if (elapsed >= 0 && elapsed < WSL_USAGE_SNAPSHOT_INTERVAL_MS) {
        return false
      }
      // Stamp attempts before gathering so failed/dropped sends do not repeat the cost hourly.
      this.lastSentAt = now
      await writeFile(this.stampFile, JSON.stringify({ lastSentAt: now })).catch(() => {})
      const input = await (
        this.deps.gather ?? (() => gatherWslUsageSnapshotInput(this.store, this.userDataPath))
      )()
      return track('wsl_usage_snapshot', buildWslUsageSnapshot(input))
    } catch (error) {
      console.warn('[telemetry] wsl usage snapshot failed:', error)
      return false
    } finally {
      this.running = false
    }
  }
}
