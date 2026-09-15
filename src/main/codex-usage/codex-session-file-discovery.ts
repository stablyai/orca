import { join, win32 as pathWin32 } from 'node:path'
import { existsSync } from 'node:fs'
import { realpath, readdir, stat } from 'node:fs/promises'
import { parseWslUncPath } from '../../shared/wsl-paths'
import { getOrcaManagedCodexHomePath, getSystemCodexHomePath } from '../codex/codex-home-paths'
import { getCodexAccountHomeSessionDirectories } from '../codex/codex-account-home-discovery'
import { getLegacyCopiedCodexSessionBridgeScanPreference } from '../codex/codex-session-bridge'
import { normalizeFsPath } from '../usage/usage-path-comparison'
import { WSL_CODEX_RUNTIME_HOME_SEGMENTS } from '../pty/codex-home-wsl-env'
import { getWslHomeAsync, listRunningWslDistrosAsync } from '../wsl'

const YIELD_EVERY_DISCOVERY_ENTRIES = 100

export async function canonicalizePath(pathValue: string): Promise<string> {
  try {
    const resolved = await realpath(pathValue)
    return normalizeFsPath(resolved)
  } catch {
    return normalizeFsPath(pathValue)
  }
}

export async function yieldToEventLoop(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve))
}

async function walkJsonlFiles(
  dirPath: string,
  progress: { entriesVisited: number } = { entriesVisited: 0 }
): Promise<string[]> {
  const entries = await readdir(dirPath, { withFileTypes: true })
  const files: string[] = []

  for (const entry of entries) {
    progress.entriesVisited += 1
    if (progress.entriesVisited % YIELD_EVERY_DISCOVERY_ENTRIES === 0) {
      await yieldToEventLoop()
    }
    const fullPath = join(dirPath, entry.name)
    if (entry.isDirectory()) {
      appendDiscoveredFiles(files, await walkJsonlFiles(fullPath, progress))
      continue
    }
    if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      files.push(fullPath)
    }
  }

  return files
}

function appendDiscoveredFiles(target: string[], source: readonly string[]): void {
  // Why: large session directories can exceed V8's argument limit if child
  // file arrays are spread into push().
  for (const filePath of source) {
    target.push(filePath)
  }
}

export function getCodexSessionsDirectory(): string {
  // Why: Orca-launched Codex processes receive an Orca-owned CODEX_HOME, so
  // callers that need the primary runtime path should not consult ambient
  // shell CODEX_HOME.
  return join(getOrcaManagedCodexHomePath(), 'sessions')
}

export function getCodexSessionDirectories(): string[] {
  // Why: sessions now live in three lanes — the shared runtime mirror, the real
  // ~/.codex, and per-account self-contained homes; missing any lane silently
  // undercounts usage for multi-account users.
  return [
    getCodexSessionsDirectory(),
    join(getSystemCodexHomePath(), 'sessions'),
    ...getCodexAccountHomeSessionDirectories()
  ].filter((dirPath, index, allDirPaths) => allDirPaths.indexOf(dirPath) === index)
}

type WslCodexSessionLanePair = {
  managedSessionsRoot: string
  systemSessionsRoot: string
}

// Why: WSL Codex transcripts are invisible to the Windows lanes, so usage shows
// zero whenever Codex runs inside a distro. Reachable only as UNC paths, so the
// lanes are emitted per running distro from the distro home.
export async function getWslCodexSessionDirectories(): Promise<string[]> {
  const lanePairs = await getWslCodexSessionLanePairs()
  return lanePairs
    .flatMap((lanePair) => [lanePair.managedSessionsRoot, lanePair.systemSessionsRoot])
    .filter((dirPath, index, allDirPaths) => allDirPaths.indexOf(dirPath) === index)
}

async function getWslCodexSessionLanePairs(): Promise<WslCodexSessionLanePair[]> {
  if (process.platform !== 'win32') {
    return []
  }
  const lanePairs: WslCodexSessionLanePair[] = []
  for (const distro of await listRunningWslDistrosAsync()) {
    const home = await getWslHomeAsync(distro)
    if (!home) {
      continue
    }
    lanePairs.push({
      managedSessionsRoot: joinWslHomePath(home, ...WSL_CODEX_RUNTIME_HOME_SEGMENTS, 'sessions'),
      systemSessionsRoot: joinWslHomePath(home, '.codex', 'sessions')
    })
  }
  return lanePairs
}

// Why: mirrors runtime-home-service joinWslPath; UNC homes need win32 join semantics.
function joinWslHomePath(basePath: string, ...segments: string[]): string {
  return parseWslUncPath(basePath)
    ? pathWin32.join(basePath, ...segments)
    : join(basePath, ...segments)
}

function hasLegacyCopiedSessionBridgeMarkers(): boolean {
  return existsSync(join(getOrcaManagedCodexHomePath(), '.orca-session-copies'))
}

export async function listCodexSessionFiles(): Promise<string[]> {
  const files: string[] = []
  const wslLanePairs = await getWslCodexSessionLanePairs()
  const directories = [
    ...getCodexSessionDirectories(),
    ...wslLanePairs.flatMap((lanePair) => [
      lanePair.managedSessionsRoot,
      lanePair.systemSessionsRoot
    ])
  ]
  for (const dirPath of directories) {
    try {
      appendDiscoveredFiles(files, await walkJsonlFiles(dirPath))
    } catch {
      // Missing or unreadable history in one home should not hide the other.
    }
  }
  return dedupeCodexSessionFileAliases(
    dropWslHardLinkTwinFiles(files, wslLanePairs),
    hasLegacyCopiedSessionBridgeMarkers()
  )
}

function getWslLaneRelativePath(filePath: string, sessionsRoot: string): string | null {
  // Why: walkJsonlFiles joins with the host path module, so separators can mix
  // inside UNC spellings; compare separator-insensitively but case-sensitively
  // (Linux paths inside a distro are case-sensitive).
  const normalizedFilePath = filePath.replaceAll('\\', '/')
  const normalizedRoot = `${sessionsRoot.replaceAll('\\', '/').replace(/\/+$/, '')}/`
  return normalizedFilePath.startsWith(normalizedRoot)
    ? normalizedFilePath.slice(normalizedRoot.length)
    : null
}

function dropWslHardLinkTwinFiles(
  files: readonly string[],
  lanePairs: readonly WslCodexSessionLanePair[]
): string[] {
  if (lanePairs.length === 0) {
    return [...files]
  }
  // Why: wsl-codex-session-bridge hard-links system rollouts into the managed
  // root, so one rollout appears in both lanes of a distro. UNC stat inode
  // identity is unreliable over the WSL 9p filesystem, so twins match by
  // relative path instead and the managed copy wins.
  const systemTwinPaths = new Set<string>()
  for (const lanePair of lanePairs) {
    const managedRelativePaths = new Set<string>()
    for (const filePath of files) {
      const relativePath = getWslLaneRelativePath(filePath, lanePair.managedSessionsRoot)
      if (relativePath !== null) {
        managedRelativePaths.add(relativePath)
      }
    }
    if (managedRelativePaths.size === 0) {
      continue
    }
    for (const filePath of files) {
      const relativePath = getWslLaneRelativePath(filePath, lanePair.systemSessionsRoot)
      if (relativePath !== null && managedRelativePaths.has(relativePath)) {
        systemTwinPaths.add(filePath)
      }
    }
  }
  if (systemTwinPaths.size === 0) {
    return [...files]
  }
  return files.filter((filePath) => !systemTwinPaths.has(filePath))
}

async function dedupeCodexSessionFileAliases(
  files: string[],
  hasLegacyBridgeMarkers: boolean
): Promise<string[]> {
  const excludedAliases = new Set<string>()
  if (hasLegacyBridgeMarkers) {
    for (const [index, filePath] of files.entries()) {
      const legacyCopyBridge = getLegacyCopiedCodexSessionBridgeScanPreference(filePath)
      if ((index + 1) % YIELD_EVERY_DISCOVERY_ENTRIES === 0) {
        await yieldToEventLoop()
      }
      if (!legacyCopyBridge) {
        continue
      }
      if (legacyCopyBridge.sourceSkipBytes !== null) {
        continue
      }
      excludedAliases.add(
        await getPhysicalFileAliasKey(
          legacyCopyBridge.preferManagedCopy ? legacyCopyBridge.sourcePath : filePath
        )
      )
    }
  }

  const seenAliases = new Set<string>()
  const uniqueFiles: string[] = []
  for (const [index, filePath] of [...new Set(files)].sort().entries()) {
    const aliasKey = await getCodexSessionFileAliasKey(filePath)
    if (excludedAliases.has(aliasKey)) {
      continue
    }
    if (seenAliases.has(aliasKey)) {
      continue
    }
    seenAliases.add(aliasKey)
    uniqueFiles.push(filePath)
    if ((index + 1) % YIELD_EVERY_DISCOVERY_ENTRIES === 0) {
      await yieldToEventLoop()
    }
  }
  return uniqueFiles
}

async function getCodexSessionFileAliasKey(filePath: string): Promise<string> {
  return getPhysicalFileAliasKey(filePath)
}

async function getPhysicalFileAliasKey(filePath: string): Promise<string> {
  try {
    const fileStat = await stat(filePath)
    if (fileStat.ino !== 0) {
      return `${fileStat.dev}:${fileStat.ino}`
    }
  } catch {}
  return `path:${await canonicalizePath(filePath)}`
}

export function getLegacySourceSkipBytesByPath(
  files: string[],
  hasLegacyBridgeMarkers = hasLegacyCopiedSessionBridgeMarkers()
): Map<string, number> {
  const sourceSkipBytesByPath = new Map<string, number>()
  if (!hasLegacyBridgeMarkers) {
    return sourceSkipBytesByPath
  }
  for (const filePath of files) {
    const legacyCopyBridge = getLegacyCopiedCodexSessionBridgeScanPreference(filePath)
    if (!legacyCopyBridge || legacyCopyBridge.sourceSkipBytes === null) {
      continue
    }
    const existing = sourceSkipBytesByPath.get(legacyCopyBridge.sourcePath) ?? 0
    sourceSkipBytesByPath.set(
      legacyCopyBridge.sourcePath,
      Math.max(existing, legacyCopyBridge.sourceSkipBytes)
    )
  }
  return sourceSkipBytesByPath
}
