import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync
} from 'node:fs'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import { getOrcaManagedCodexHomePath, getSystemCodexHomePath } from './codex-home-paths'

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

export function syncSystemCodexSessionsIntoManagedHome(): void {
  const systemSessionsRoot = join(getSystemCodexHomePath(), 'sessions')
  if (!existsSync(systemSessionsRoot)) {
    return
  }

  const managedSessionsRoot = join(getOrcaManagedCodexHomePath(), 'sessions')
  for (const systemSessionFilePath of listCodexSessionJsonlFiles(systemSessionsRoot)) {
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
        continue
      }
      migrateLegacyCopiedSessionBridge(systemSessionFilePath, managedSessionFilePath, relativePath)
      continue
    }
    mkdirSync(dirname(managedSessionFilePath), { recursive: true })
    linkSystemCodexSessionFile(systemSessionFilePath, managedSessionFilePath, relativePath)
  }
}

function listCodexSessionJsonlFiles(rootPath: string): string[] {
  const files: string[] = []
  try {
    for (const entry of readdirSync(rootPath, { withFileTypes: true })) {
      const childPath = join(rootPath, entry.name)
      if (entry.isDirectory()) {
        appendSessionFilePaths(files, listCodexSessionJsonlFiles(childPath))
        continue
      }
      if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        files.push(childPath)
      }
    }
  } catch (error) {
    console.warn('[codex-session-bridge] Failed to list system Codex sessions:', error)
  }
  return files.sort()
}

function appendSessionFilePaths(target: string[], source: readonly string[]): void {
  // Why: existing Codex homes can accumulate enough nested sessions to exceed
  // V8's argument limit if child arrays are spread into push().
  for (const filePath of source) {
    target.push(filePath)
  }
}

function linkSystemCodexSessionFile(
  sourcePath: string,
  targetPath: string,
  relativePath: string
): boolean {
  const linked = tryLinkSystemCodexSessionFile(sourcePath, targetPath)
  if (linked) {
    clearLegacyCopiedSessionMarker(relativePath)
  }
  return linked
}

function tryLinkSystemCodexSessionFile(sourcePath: string, targetPath: string): boolean {
  if (tryHardlinkSystemCodexSessionFile(sourcePath, targetPath)) {
    return true
  }
  try {
    // Why fallback: hardlinks keep sessions visible to Codex resume, but can
    // fail across volumes. A symlink is still better than a diverging copy.
    symlinkSync(sourcePath, targetPath, process.platform === 'win32' ? 'file' : undefined)
    return true
  } catch (error) {
    console.warn('[codex-session-bridge] Failed to link system Codex session:', sourcePath, error)
  }
  return false
}

function tryHardlinkSystemCodexSessionFile(sourcePath: string, targetPath: string): boolean {
  try {
    // Why: Codex resume ignores symlinked JSONL sessions, while a hardlink
    // preserves one physical log without copy divergence.
    linkSync(sourcePath, targetPath)
    return true
  } catch {
    return false
  }
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
    if (!tryHardlinkSystemCodexSessionFile(sourcePath, replacementPath)) {
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
    if (!tryLinkSystemCodexSessionFile(sourcePath, replacementPath)) {
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
    // Why: legacy copied bridges share a prefix with the source. Scanner must
    // choose one full log until the bridge can be replaced with a real link.
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
