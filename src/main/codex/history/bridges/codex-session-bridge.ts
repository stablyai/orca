import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync
} from 'node:fs'
import { lstat } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import {
  getOrcaManagedCodexHomePath,
  getSystemCodexHomePath
} from '../../configuration/homes/codex-home-paths'
import {
  listCodexSessionJsonlFiles,
  listCodexSessionJsonlFilesIncrementally
} from '../rollouts/codex-session-file-listing'
import { linkCodexSessionFile, tryHardlinkCodexSessionFile } from '../rollouts/codex-session-link'
import type { CodexSessionBridgeIncrementalOptions } from '../rollouts/codex-session-file-listing'
import {
  fileStatsMatchMarker,
  parseLegacyCopiedSessionMarker,
  setAsideLegacyCopy,
  type LegacyCopiedSessionMarker
} from './codex-legacy-session-copy'

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
  const markersRoot = join(dirname(managedSessionsRoot), '.orca-session-copies')
  const hasLegacyCopies = (await lstat(markersRoot).catch(() => null))?.isDirectory() === true
  const summary: CodexSessionBridgeSummary = { scannedFiles: 0, linkedFiles: 0 }
  for await (const systemSessionFilePath of listCodexSessionJsonlFilesIncrementally(
    systemSessionsRoot,
    options
  )) {
    summary.scannedFiles += 1
    const relativePath = relative(systemSessionsRoot, systemSessionFilePath)
    if (
      bridgeSystemCodexSessionFile(
        systemSessionsRoot,
        managedSessionsRoot,
        systemSessionFilePath
      ) ||
      (hasLegacyCopies &&
        (await setAsideLegacyCopy(
          systemSessionFilePath,
          join(managedSessionsRoot, relativePath),
          join(markersRoot, `${relativePath}.json`)
        )))
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
    forgetLinkedLegacyCopy(managedSessionFilePath, relativePath)
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

// Only a copy something already turned into a link drops its marker here.
function forgetLinkedLegacyCopy(targetPath: string, relativePath: string): void {
  try {
    if (lstatSync(targetPath).isSymbolicLink()) {
      clearLegacyCopiedSessionMarker(relativePath)
    }
  } catch {
    // Left for a later pass.
  }
}

/** Keep resume scans coherent until legacy copies are replaced with links. */
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
    return parseLegacyCopiedSessionMarker(
      readFileSync(getLegacySessionCopyMarkerPath(relativePath), 'utf-8')
    )
  } catch {
    return null
  }
}

function clearLegacyCopiedSessionMarker(relativePath: string): void {
  rmSync(getLegacySessionCopyMarkerPath(relativePath), { force: true })
}
