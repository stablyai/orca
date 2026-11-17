/**
 * Which distros the user has legacy-bridge work on: work Windows-side Orca does through `wsl.exe`
 * or a `\\wsl.localhost` share. A WSL host's distro is not here; its orcad does that work inside.
 * Background probes (#28000, #13190) are scoped to these distros, and skipped when there are none.
 */
import type { GlobalSettings } from '../../../shared/settings/global-settings-types'
import type { Repo } from '../../../shared/repository/repo-types'
import type { FolderWorkspace } from '../../../shared/folder-workspaces/folder-workspace-types'
import {
  getRepoExecutionHostId,
  LOCAL_EXECUTION_HOST_ID
} from '../../../shared/execution-host/execution-host'
import { parseWslUncPath } from '../../../shared/file-access/wsl-paths'
import { isWslShellName } from '../../../shared/shell/launch/local-windows-terminal-runtime'
import {
  resolveLocalWorkspaceRuntime,
  type ProjectRuntimeResolutionStore
} from '../../workspaces/execution-host/local-project-runtime-resolution'
import { classifyLocalWslProject } from '../../telemetry/wsl-usage-snapshot'
import { loadWindowsNativeRegistry, WINDOWS_REG_SZ } from '../../windows/windows-native-registry'

export type LegacyWslDemandStore = Omit<ProjectRuntimeResolutionStore, 'getSettings'> & {
  getRepos: () => Repo[]
  getFolderWorkspaces?: () => FolderWorkspace[]
  getSettings: () => Partial<
    Pick<
      GlobalSettings,
      | 'localWindowsRuntimeDefault'
      | 'experimentalWslHosts'
      | 'agentCmdOverrides'
      | 'terminalWindowsShell'
      | 'terminalWindowsWslDistro'
    >
  >
}

export type LegacyWslDemand = {
  /** Named distros, as the user's paths and settings spell them. */
  distros: string[]
  /** Some work runs in whichever distro `wsl.exe` defaults to. */
  defaultDistro: boolean
}

/** A drive letter's `net use` target, read from the registry; no spawn and no share access. */
export type ReadMappedDriveShare = (letter: string) => string | null

const DRIVE_PATH = /^([A-Za-z]):(?:[\\/]|$)/

function readMappedDriveShareFromRegistry(letter: string): string | null {
  try {
    const registry = loadWindowsNativeRegistry()
    const values = registry.getRegistryKey(registry.HK.CU, `Network\\${letter.toUpperCase()}`)
    const remote = Object.entries(values ?? {}).find(
      ([name]) => name.toLowerCase() === 'remotepath'
    )?.[1]
    return remote?.type === WINDOWS_REG_SZ && typeof remote.value === 'string' ? remote.value : null
  } catch {
    return null
  }
}

/** The distro a path names: a WSL share, or a drive letter mapped to one. */
function distroForPath(path: string, readMappedDrive: ReadMappedDriveShare): string | null {
  const unc = parseWslUncPath(path)
  if (unc) {
    return unc.distro
  }
  const letter = DRIVE_PATH.exec(path)?.[1]
  const share = letter ? readMappedDrive(letter) : null
  return share ? (parseWslUncPath(share)?.distro ?? null) : null
}

export function readLegacyWslDemand(
  store: LegacyWslDemandStore,
  readMappedDrive: ReadMappedDriveShare = readMappedDriveShareFromRegistry
): LegacyWslDemand {
  const distros = new Map<string, string>()
  let defaultDistro = false
  const add = (distro: string | null): void => {
    const name = distro?.trim()
    if (name) {
      distros.set(name.toLowerCase(), name)
    } else {
      defaultDistro = true
    }
  }
  // Drive lookups repeat across a project's worktree folders.
  const mappedDrives = new Map<string, string | null>()
  const readMappedDriveOnce: ReadMappedDriveShare = (letter) => {
    const key = letter.toUpperCase()
    if (!mappedDrives.has(key)) {
      mappedDrives.set(key, readMappedDrive(key))
    }
    return mappedDrives.get(key) ?? null
  }
  for (const repo of store.getRepos()) {
    if (getRepoExecutionHostId(repo) !== LOCAL_EXECUTION_HOST_ID) {
      continue
    }
    const pathDistro =
      distroForPath(repo.path, readMappedDriveOnce) ??
      (repo.worktreeBasePath ? distroForPath(repo.worktreeBasePath, readMappedDriveOnce) : null)
    if (pathDistro) {
      add(pathDistro)
      continue
    }
    const project = classifyLocalWslProject(
      repo,
      resolveLocalWorkspaceRuntime(store, repo, repo.path)
    )
    if (project) {
      add(project.distro)
    }
  }
  for (const workspace of store.getFolderWorkspaces?.() ?? []) {
    const host = workspace.executionHostId ?? LOCAL_EXECUTION_HOST_ID
    if (workspace.connectionId || host !== LOCAL_EXECUTION_HOST_ID) {
      continue
    }
    const distro = distroForPath(workspace.folderPath, readMappedDriveOnce)
    if (distro) {
      add(distro)
    }
  }
  const settings = store.getSettings()
  if (isWslShellName(settings.terminalWindowsShell)) {
    add(settings.terminalWindowsWslDistro ?? null)
  }
  return { distros: [...distros.values()], defaultDistro }
}

export function hasLegacyWslDemand(demand: LegacyWslDemand): boolean {
  return demand.defaultDistro || demand.distros.length > 0
}

/**
 * `candidates` the demand covers. `defaultDistro` names the distro `wsl.exe` defaults to, when
 * known; unknown keeps every candidate, since any of them may be the default.
 */
export function filterToLegacyWslDemand(
  candidates: readonly string[],
  demand: LegacyWslDemand,
  defaultDistro: string | null | undefined
): string[] {
  const wanted = new Set(demand.distros.map((distro) => distro.toLowerCase()))
  return candidates.filter((candidate) => {
    const key = candidate.toLowerCase()
    if (wanted.has(key)) {
      return true
    }
    if (!demand.defaultDistro) {
      return false
    }
    return defaultDistro === undefined || defaultDistro?.toLowerCase() === key
  })
}

let demandStore: LegacyWslDemandStore | null = null

/** Main installs the loaded store; until then (and in utility processes) demand is unknown. */
export function setLegacyWslDemandStore(store: LegacyWslDemandStore | null): void {
  demandStore = store
}

/** Null before the store loads or outside main: callers keep their unscoped behavior. */
export function currentLegacyWslDemand(): LegacyWslDemand | null {
  if (process.platform !== 'win32' || !demandStore) {
    return null
  }
  try {
    return readLegacyWslDemand(demandStore)
  } catch {
    return null
  }
}
