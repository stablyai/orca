import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { realpath, readdir, stat } from 'node:fs/promises'
import { getOrcaManagedCodexHomePath, getSystemCodexHomePath } from '../codex/codex-home-paths'
import { getCodexAccountHomeSessionDirectories } from '../codex/codex-account-home-discovery'
import { getLegacyCopiedCodexSessionBridgeScanPreference } from '../codex/codex-session-bridge'
import { normalizeFsPath } from '../usage/usage-path-comparison'

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

function hasLegacyCopiedSessionBridgeMarkers(): boolean {
  return existsSync(join(getOrcaManagedCodexHomePath(), '.orca-session-copies'))
}

export async function listCodexSessionFiles(): Promise<string[]> {
  const files: string[] = []
  for (const dirPath of getCodexSessionDirectories()) {
    try {
      appendDiscoveredFiles(files, await walkJsonlFiles(dirPath))
    } catch {
      // Missing or unreadable history in one home should not hide the other.
    }
  }
  return dedupeCodexSessionFileAliases(files, hasLegacyCopiedSessionBridgeMarkers())
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
