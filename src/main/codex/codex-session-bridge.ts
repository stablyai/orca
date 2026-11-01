import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync
} from 'node:fs'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import { getOrcaManagedCodexHomePath, getSystemCodexHomePath } from './codex-home-paths'
import {
  listCodexSessionJsonlFiles,
  listCodexSessionJsonlFilesIncrementally
} from './codex-session-file-listing'
import { linkCodexSessionFile, tryHardlinkCodexSessionFile } from './codex-session-link'
import type { CodexSessionBridgeIncrementalOptions } from './codex-session-file-listing'

export type { CodexSessionBridgeIncrementalOptions } from './codex-session-file-listing'

type LegacyCopiedSessionMarker = {
  sourcePath: string
  sourceSize: number
  sourceMtimeMs: number
  targetSize: number
  targetMtimeMs: number
}

export type LegacyCopiedCodexSessionBridgeScanPreference = {
  sourcePath: string
  preferManagedCopy: boolean
  sourceSkipBytes: number | null
}

export type CodexSessionBridgeSummary = {
  scannedFiles: number
  linkedFiles: number
}

let backgroundSessionBridgeTask: Promise<void> | null = null

/** Custom CODEX_HOME changes history discovery only. */
export function syncSystemCodexSessionsIntoManagedHome(sourceCodexHomePath?: string): void {
  const systemSessionsRoot = join(sourceCodexHomePath || getSystemCodexHomePath(), 'sessions')
  if (!existsSync(systemSessionsRoot)) {
    return
  }

  const managedSessionsRoot = join(getOrcaManagedCodexHomePath(), 'sessions')
  for (const systemSessionFilePath of listCodexSessionJsonlFiles(systemSessionsRoot)) {
    bridgeSystemCodexSessionFile(systemSessionsRoot, managedSessionsRoot, systemSessionFilePath)
  }
}

export function startSystemCodexSessionBridgeInBackground(
  options: CodexSessionBridgeIncrementalOptions = {},
  sourceCodexHomePath?: string
): Promise<void> {
  if (backgroundSessionBridgeTask) {
    return backgroundSessionBridgeTask
  }
  const task = syncSystemCodexSessionsIntoManagedHomeIncrementally(options, sourceCodexHomePath)
    .catch((error: unknown) => {
      console.warn('[codex-session-bridge] Background session bridge failed:', error)
    })
    .then(() => undefined)
  backgroundSessionBridgeTask = task
  void task.finally(() => {
    if (backgroundSessionBridgeTask === task) {
      backgroundSessionBridgeTask = null
    }
  })
  return task
}

export async function syncSystemCodexSessionsIntoManagedHomeIncrementally(
  options: CodexSessionBridgeIncrementalOptions = {},
  sourceCodexHomePath?: string
): Promise<CodexSessionBridgeSummary> {
  const systemSessionsRoot = join(sourceCodexHomePath || getSystemCodexHomePath(), 'sessions')
  if (!existsSync(systemSessionsRoot)) {
    return { scannedFiles: 0, linkedFiles: 0 }
  }

  const managedSessionsRoot = join(getOrcaManagedCodexHomePath(), 'sessions')
  const summary: CodexSessionBridgeSummary = { scannedFiles: 0, linkedFiles: 0 }
  for await (const systemSessionFilePath of listCodexSessionJsonlFilesIncrementally(
    systemSessionsRoot,
    options
  )) {
    summary.scannedFiles += 1
    if (
      bridgeSystemCodexSessionFile(systemSessionsRoot, managedSessionsRoot, systemSessionFilePath)
    ) {
      summary.linkedFiles += 1
    }
  }
  return summary
}

function bridgeSystemCodexSessionFile(
  systemSessionsRoot: string,
  managedSessionsRoot: string,
  systemSessionFilePath: string
): boolean {
  const relativePath = relative(systemSessionsRoot, systemSessionFilePath)
  const managedSessionFilePath = join(managedSessionsRoot, relativePath)
  if (existsSync(managedSessionFilePath)) {
    if (
      replaceSymlinkSessionBridgeWithHardlink(
        systemSessionFilePath,
        managedSessionFilePath,
        relativePath
      )
    ) {
      return true
    }
    migrateLegacyCopiedSessionBridge(systemSessionFilePath, managedSessionFilePath, relativePath)
    return false
  }
  mkdirSync(dirname(managedSessionFilePath), { recursive: true })
  return linkSystemCodexSessionFile(systemSessionFilePath, managedSessionFilePath, relativePath)
}

function linkSystemCodexSessionFile(
  sourcePath: string,
  targetPath: string,
  relativePath: string
): boolean {
  const linked = linkCodexSessionFile(sourcePath, targetPath)
  if (linked) {
    clearLegacyCopiedSessionMarker(relativePath)
  }
  return linked
}

function replaceSymlinkSessionBridgeWithHardlink(
  sourcePath: string,
  targetPath: string,
  relativePath: string
): boolean {
  let replacementPath: string | null = null
  try {
    const targetStat = lstatSync(targetPath)
    if (!targetStat.isSymbolicLink()) {
      return false
    }
    const linkTarget = readlinkSync(targetPath)
    const absoluteLinkTarget = isAbsolute(linkTarget)
      ? linkTarget
      : join(dirname(targetPath), linkTarget)
    if (absoluteLinkTarget !== sourcePath) {
      return false
    }

    replacementPath = `${targetPath}.orca-link-${process.pid}-${Date.now()}`
    if (!tryHardlinkCodexSessionFile(sourcePath, replacementPath)) {
      return false
    }
    rmSync(targetPath, { force: true })
    renameSync(replacementPath, targetPath)
    clearLegacyCopiedSessionMarker(relativePath)
    return true
  } catch (error) {
    console.warn(
      '[codex-session-bridge] Failed to replace symlinked Codex session bridge:',
      sourcePath,
      error
    )
    if (replacementPath) {
      rmSync(replacementPath, { force: true })
    }
  }
  return false
}

function migrateLegacyCopiedSessionBridge(
  sourcePath: string,
  targetPath: string,
  relativePath: string
): void {
  const marker = readLegacyCopiedSessionMarker(relativePath)
  if (!marker || marker.sourcePath !== sourcePath) {
    return
  }
  let replacementPath: string | null = null
  try {
    const targetStat = lstatSync(targetPath)
    if (targetStat.isSymbolicLink()) {
      clearLegacyCopiedSessionMarker(relativePath)
      return
    }
    if (!fileStatsMatchMarker(targetStat, marker, 'target')) {
      return
    }
    replacementPath = `${targetPath}.orca-link-${process.pid}-${Date.now()}`
    if (!linkCodexSessionFile(sourcePath, replacementPath)) {
      return
    }
    rmSync(targetPath, { force: true })
    renameSync(replacementPath, targetPath)
    clearLegacyCopiedSessionMarker(relativePath)
  } catch (error) {
    console.warn(
      '[codex-session-bridge] Failed to migrate copied system Codex session:',
      sourcePath,
      error
    )
    if (replacementPath) {
      rmSync(replacementPath, { force: true })
    }
  }
}

/** Keep resume scans coherent until legacy copies can be replaced with links. */
export function getLegacyCopiedCodexSessionBridgeScanPreference(
  sessionFilePath: string
): LegacyCopiedCodexSessionBridgeScanPreference | null {
  const managedSessionsRoot = join(getOrcaManagedCodexHomePath(), 'sessions')
  const relativePath = relative(managedSessionsRoot, sessionFilePath)
  if (
    relativePath === '' ||
    relativePath === '..' ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  ) {
    return null
  }
  const marker = readLegacyCopiedSessionMarker(relativePath)
  if (!marker) {
    return null
  }

  let targetMatchesMarker = false
  let sourceMatchesMarker = false
  try {
    targetMatchesMarker = fileStatsMatchMarker(lstatSync(sessionFilePath), marker, 'target')
  } catch {}
  try {
    sourceMatchesMarker = fileStatsMatchMarker(lstatSync(marker.sourcePath), marker, 'source')
  } catch {}

  return {
    sourcePath: marker.sourcePath,
    // Legacy copies share a prefix with their source; scan one full log until they become linked.
    preferManagedCopy: !targetMatchesMarker || sourceMatchesMarker,
    sourceSkipBytes: !targetMatchesMarker && !sourceMatchesMarker ? marker.sourceSize : null
  }
}

function getLegacySessionCopyMarkerPath(relativePath: string): string {
  return join(getOrcaManagedCodexHomePath(), '.orca-session-copies', `${relativePath}.json`)
}

function readLegacyCopiedSessionMarker(relativePath: string): LegacyCopiedSessionMarker | null {
  try {
    const parsed: unknown = JSON.parse(
      readFileSync(getLegacySessionCopyMarkerPath(relativePath), 'utf-8')
    )
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null
    }
    const marker = parsed as Record<string, unknown>
    if (
      typeof marker.sourcePath !== 'string' ||
      typeof marker.sourceSize !== 'number' ||
      typeof marker.sourceMtimeMs !== 'number' ||
      typeof marker.targetSize !== 'number' ||
      typeof marker.targetMtimeMs !== 'number'
    ) {
      return null
    }
    return marker as LegacyCopiedSessionMarker
  } catch {
    return null
  }
}

function fileStatsMatchMarker(
  stat: { size: number; mtimeMs: number },
  marker: LegacyCopiedSessionMarker,
  kind: 'source' | 'target'
): boolean {
  const expectedSize = kind === 'source' ? marker.sourceSize : marker.targetSize
  const expectedMtimeMs = kind === 'source' ? marker.sourceMtimeMs : marker.targetMtimeMs
  return stat.size === expectedSize && stat.mtimeMs === expectedMtimeMs
}

function clearLegacyCopiedSessionMarker(relativePath: string): void {
  rmSync(getLegacySessionCopyMarkerPath(relativePath), { force: true })
}
