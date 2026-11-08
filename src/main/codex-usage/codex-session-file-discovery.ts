import { join, win32 } from 'node:path'
import { existsSync } from 'node:fs'
import {
  getOrcaManagedCodexHomePath,
  getSystemCodexHomePath
} from '../codex/configuration/homes/codex-home-paths'
import { getCodexAccountHomeSessionDirectories } from '../codex/history/rollouts/codex-account-home-discovery'
import { getLegacyCopiedCodexSessionBridgeScanPreference } from '../codex/history/bridges/codex-session-bridge'
import { normalizeFsPath } from '../usage/usage-path-comparison'
import { isDefinitiveAbsence } from '../../shared/definitive-filesystem-absence'
import { parseWslUncPath, wslUncDrivePathToWindows } from '../../shared/wsl-paths'
import { wslGatedReaddir, wslGatedRealpath } from '../native-chat/wsl-transcript-fs-access'
import { readJsonlFileSnapshot } from '../usage/jsonl-file-snapshot'
import type { CodexUsageSourceDiscovery } from './codex-usage-sources'

const YIELD_EVERY_DISCOVERY_ENTRIES = 100

export async function canonicalizePath(pathValue: string): Promise<string> {
  try {
    const resolved = await wslGatedRealpath(pathValue)
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
  const entries = await wslGatedReaddir(dirPath, 'scan').catch((error: unknown) => {
    if (isDefinitiveAbsence(error)) {
      return []
    }
    throw error
  })
  const files: string[] = []

  for (const entry of entries) {
    progress.entriesVisited += 1
    if (progress.entriesVisited % YIELD_EVERY_DISCOVERY_ENTRIES === 0) {
      await yieldToEventLoop()
    }
    const fullPath = parseWslUncPath(dirPath)
      ? win32.join(dirPath, entry.name)
      : join(dirPath, entry.name)
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
  // Spreading large directory listings into push() can exceed V8's argument limit.
  for (const filePath of source) {
    target.push(filePath)
  }
}

export function getCodexSessionsDirectory(): string {
  // The primary runtime uses an Orca-owned home regardless of ambient CODEX_HOME.
  return join(getOrcaManagedCodexHomePath(), 'sessions')
}

export function getCodexSessionDirectories(): string[] {
  // Include runtime, system and account homes to avoid undercounting multi-account usage.
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
  return (await discoverCodexSessionFiles()).files
}

export async function discoverCodexSessionFiles(
  sourceDiscovery?: CodexUsageSourceDiscovery
): Promise<{
  files: string[]
  sourceDistroByPath: Map<string, string>
  complete: boolean
}> {
  const files: string[] = []
  const sourceDistroByPath = new Map<string, string>()
  let complete = sourceDiscovery?.complete ?? true
  for (const dirPath of getCodexSessionDirectories()) {
    appendDiscoveredFiles(files, await walkJsonlFiles(dirPath))
  }
  for (const source of sourceDiscovery?.sources ?? []) {
    try {
      const discovered = await walkJsonlFiles(source.directory)
      appendDiscoveredFiles(files, discovered)
      for (const path of discovered) {
        sourceDistroByPath.set(path, source.distro)
      }
    } catch {
      complete = false
    }
  }
  return {
    files: await dedupeCodexSessionFileAliases(
      files,
      hasLegacyCopiedSessionBridgeMarkers(),
      sourceDistroByPath
    ),
    sourceDistroByPath,
    complete
  }
}

async function dedupeCodexSessionFileAliases(
  files: string[],
  hasLegacyBridgeMarkers: boolean,
  sourceDistroByPath: ReadonlyMap<string, string>
): Promise<string[]> {
  const excludedAliases = new Set<string>()
  if (hasLegacyBridgeMarkers) {
    for (const [index, filePath] of files.entries()) {
      const legacyCopyBridge = parseWslUncPath(filePath)
        ? null
        : getLegacyCopiedCodexSessionBridgeScanPreference(filePath)
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
  const ordered = [...new Set(files)].sort((left, right) =>
    compareCodexSourcePriority(left, right, sourceDistroByPath)
  )
  for (const [index, filePath] of ordered.entries()) {
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
    // Windows file IDs can exceed the precision of JavaScript numbers.
    const fileStat = await readJsonlFileSnapshot(filePath)
    if (fileStat.ino !== 0n) {
      const wsl = parseWslUncPath(filePath)
      const distro =
        wsl && !wslUncDrivePathToWindows(filePath, wsl.distro) ? wsl.distro.toLowerCase() : null
      return `${distro ? `wsl:${distro}:` : ''}${fileStat.dev}:${fileStat.ino}`
    }
  } catch {}
  return `path:${await canonicalizePath(filePath)}`
}

export function compareCodexSourcePriority(
  left: string,
  right: string,
  sourceDistroByPath: ReadonlyMap<string, string>
): number {
  const leftWsl = sourceDistroByPath.has(left) || parseWslUncPath(left) !== null
  const rightWsl = sourceDistroByPath.has(right) || parseWslUncPath(right) !== null
  return Number(rightWsl) - Number(leftWsl) || (left < right ? -1 : left > right ? 1 : 0)
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
    if (parseWslUncPath(filePath)) {
      continue
    }
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
