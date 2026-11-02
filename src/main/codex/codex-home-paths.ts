import {
  cpSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  rmdirSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  clearCopiedResourceMarker,
  markCopiedResource,
  targetIsOwnedFallbackCopy
} from './codex-managed-home-resource-copy-marker'
import { syncSystemCodexRulesIntoManagedHome } from './codex-managed-home-rules'
import { observe, observeResolvedPathEntry } from './codex-path-observation'

const CODEX_GLOBAL_INSTRUCTIONS_ENTRY = 'AGENTS.md'

// The Codex app installs these under ~/.codex; Codex rejects them from any other home.
export const CODEX_BUNDLED_MARKETPLACES_ENTRY = join('.tmp', 'bundled-marketplaces')
export const CODEX_BUNDLED_MARKETPLACE_NAMES = ['openai-bundled', 'openai-bundled-alpha'] as const

const CODEX_SYSTEM_RESOURCE_ENTRIES = [
  'skills',
  'hooks',
  'plugins',
  'plugin-state',
  'profile-v2',
  'themes',
  'prompts',
  CODEX_BUNDLED_MARKETPLACES_ENTRY,
  CODEX_GLOBAL_INSTRUCTIONS_ENTRY
] as const

export function getSystemCodexHomePath(): string {
  return join(homedir(), '.codex')
}

/** Path only; use when a read-only caller must not materialize the mirror. */
export function resolveOrcaManagedCodexHomePath(): string {
  return join(getOrcaUserDataPath(), 'codex-runtime-home', 'home')
}

export function getOrcaManagedCodexHomePath(): string {
  const managedHomePath = resolveOrcaManagedCodexHomePath()
  mkdirSync(managedHomePath, { recursive: true })
  return managedHomePath
}

/** Config files an Orca-launched local Codex reads trust from, in the hook installer's lock order. */
export function getLocalCodexTrustConfigFiles(
  agentHome: string,
  launchCodexHome?: string | null
): string[] {
  const files = [
    join(getOrcaManagedCodexHomePath(), 'config.toml'),
    // Managed accounts launch on their own CODEX_HOME, the only config that launch reads (#27235).
    ...(launchCodexHome ? [join(launchCodexHome, 'config.toml')] : []),
    join(agentHome, '.codex', 'config.toml')
  ]
  return [...new Set(files)]
}

export function getCodexSessionBackfillStateDirPath(): string {
  return join(getOrcaUserDataPath(), 'codex-session-backfill')
}

export function getOrcaUserDataPath(): string {
  if (process.env.ORCA_USER_DATA_PATH) {
    return process.env.ORCA_USER_DATA_PATH
  }
  // Offline CLI hooks run outside Electron and must resolve the same userData path.
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'orca')
  }
  if (process.platform === 'win32') {
    return join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'orca')
  }
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'orca')
}

export function syncSystemCodexResourcesIntoManagedHome(managedHomePath?: string): void {
  const targetHome = managedHomePath ?? getOrcaManagedCodexHomePath()
  const systemHomePath = getSystemCodexHomePath()
  for (const entryName of CODEX_SYSTEM_RESOURCE_ENTRIES) {
    linkSystemCodexResource(systemHomePath, targetHome, entryName)
  }
  syncSystemCodexRulesIntoManagedHome(systemHomePath, targetHome)
}

export function syncCodexGlobalInstructionsIntoManagedHome({
  systemHomePath,
  managedHomePath
}: {
  systemHomePath: string
  managedHomePath: string
}): void {
  mkdirSync(managedHomePath, { recursive: true })
  // WSL cannot resolve host-side UNC symlink targets; copy instructions into its runtime home.
  linkSystemCodexResource(systemHomePath, managedHomePath, CODEX_GLOBAL_INSTRUCTIONS_ENTRY, {
    preferCopy: true
  })
}

function linkSystemCodexResource(
  systemHomePath: string,
  managedHomePath: string,
  entryName: string,
  { preferCopy = false }: { preferCopy?: boolean } = {}
): void {
  const sourcePath = join(systemHomePath, entryName)
  const targetPath = join(managedHomePath, entryName)
  // Distinguish unreadable sources from absent ones before deleting a managed copy.
  const sourceObservation = observeResolvedPathEntry(sourcePath)
  if (sourceObservation.kind === 'indeterminate') {
    return
  }
  if (sourceObservation.kind === 'absent') {
    removeCopiedResourceIfOwned(targetPath, managedHomePath, entryName, sourcePath)
    return
  }
  if (entryName === CODEX_GLOBAL_INSTRUCTIONS_ENTRY && !sourceObservation.value.isFile()) {
    removeCopiedResourceIfOwned(targetPath, managedHomePath, entryName, sourcePath)
    console.warn('[codex-home] Ignoring non-file system Codex resource:', entryName)
    return
  }

  if (targetAlreadyPointsToSource(targetPath, sourcePath)) {
    clearCopiedResourceMarker(managedHomePath, entryName)
    if (!preferCopy || !removeSymlinkEntry(targetPath)) {
      return
    }
  }
  // Unreadable targets must not enter the copier's removal path.
  const targetObservation = observe(() => lstatSync(targetPath))
  if (targetObservation.kind === 'indeterminate') {
    return
  }
  const shouldRefreshFallbackCopy =
    targetObservation.kind === 'present' &&
    targetIsOwnedFallbackCopy(targetPath, managedHomePath, entryName, sourcePath)
  if (targetObservation.kind === 'present' && !shouldRefreshFallbackCopy) {
    return
  }
  if (shouldRefreshFallbackCopy) {
    // Avoid rewriting unchanged instructions across UNC on every WSL launch.
    if (entryName === CODEX_GLOBAL_INSTRUCTIONS_ENTRY) {
      const contentsMatch = copiedFileContentsMatch(sourcePath, targetPath)
      if (contentsMatch === 'match' || contentsMatch === 'indeterminate') {
        // Failed comparisons must preserve the potentially only readable copy.
        return
      }
    }
    rmSync(targetPath, { recursive: true, force: true })
  }

  mkdirSync(dirname(targetPath), { recursive: true })
  if (preferCopy) {
    copySystemCodexResourceAsOwnedFallback(sourcePath, targetPath, managedHomePath, entryName)
    return
  }

  try {
    const sourceStat = lstatSync(sourcePath)
    symlinkSync(
      sourcePath,
      targetPath,
      sourceStat.isDirectory() && process.platform === 'win32' ? 'junction' : undefined
    )
    clearCopiedResourceMarker(managedHomePath, entryName)
  } catch (error) {
    // Windows may reject file symlinks; mark fallback copies so sync never replaces user-owned resources.
    copySystemCodexResourceAsOwnedFallback(
      sourcePath,
      targetPath,
      managedHomePath,
      entryName,
      error
    )
  }
}

function copySystemCodexResourceAsOwnedFallback(
  sourcePath: string,
  targetPath: string,
  managedHomePath: string,
  entryName: string,
  symlinkError?: unknown
): void {
  try {
    rmSync(targetPath, { recursive: true, force: true })
    cpSync(sourcePath, targetPath, {
      recursive: true,
      force: false,
      errorOnExist: true,
      // Materialize symlinked instructions: WSL cannot use a copied host-side link.
      dereference: entryName === CODEX_GLOBAL_INSTRUCTIONS_ENTRY
    })
    markCopiedResource(managedHomePath, entryName, sourcePath)
  } catch (copyError) {
    // Roll back unmarked copies; later sync cannot safely refresh or remove them.
    try {
      rmSync(targetPath, { recursive: true, force: true })
    } catch (cleanupError) {
      console.warn(
        '[codex-home] Failed to remove incomplete resource copy:',
        entryName,
        cleanupError
      )
    }
    console.warn(
      '[codex-home] Failed to mirror system Codex resource:',
      entryName,
      symlinkError ?? copyError
    )
  }
}

function copiedFileContentsMatch(
  sourcePath: string,
  targetPath: string
): 'match' | 'different' | 'indeterminate' {
  try {
    // Compare regular files only; synchronous FIFO/device reads can block launch.
    if (!statSync(sourcePath).isFile() || !lstatSync(targetPath).isFile()) {
      return 'different'
    }
    return readFileSync(sourcePath).equals(readFileSync(targetPath)) ? 'match' : 'different'
  } catch {
    return 'indeterminate'
  }
}

function targetAlreadyPointsToSource(targetPath: string, sourcePath: string): boolean {
  try {
    return (
      lstatSync(targetPath).isSymbolicLink() &&
      linkTargetsMatch(readlinkSync(targetPath), sourcePath)
    )
  } catch {
    return false
  }
}

function linkTargetsMatch(actualTarget: string, expectedTarget: string): boolean {
  if (process.platform !== 'win32') {
    return actualTarget === expectedTarget
  }
  return normalizeWindowsLinkTarget(actualTarget) === normalizeWindowsLinkTarget(expectedTarget)
}

function normalizeWindowsLinkTarget(linkTarget: string): string {
  return linkTarget.replace(/^\\\\\?\\/, '').toLowerCase()
}

function removeCopiedResourceIfOwned(
  targetPath: string,
  managedHomePath: string,
  entryName: string,
  sourcePath: string
): void {
  if (removeSymlinkedResourceIfOwned(targetPath, sourcePath)) {
    clearCopiedResourceMarker(managedHomePath, entryName)
    return
  }
  if (!targetIsOwnedFallbackCopy(targetPath, managedHomePath, entryName, sourcePath)) {
    return
  }
  rmSync(targetPath, { recursive: true, force: true })
  clearCopiedResourceMarker(managedHomePath, entryName)
}

function removeSymlinkedResourceIfOwned(targetPath: string, sourcePath: string): boolean {
  try {
    if (!lstatSync(targetPath).isSymbolicLink()) {
      return false
    }
    if (!linkTargetsMatch(readlinkSync(targetPath), sourcePath)) {
      return false
    }
    return removeSymlinkEntry(targetPath)
  } catch {
    return false
  }
}

function removeSymlinkEntry(targetPath: string): boolean {
  try {
    unlinkSync(targetPath)
    return true
  } catch {
    if (process.platform !== 'win32') {
      return false
    }
  }

  try {
    rmdirSync(targetPath)
    return true
  } catch {
    return false
  }
}
