import {
  createCodexRolloutVisibilityPredicate,
  withCodexRolloutPublication
} from '../deletion/codex-session-deletion-record'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync
} from 'node:fs'
import { dirname, isAbsolute, join, normalize, relative, sep } from 'node:path'
import {
  getOrcaManagedCodexHomePath,
  getSystemCodexHomePath
} from '../../configuration/homes/codex-home-paths'
import { listCodexSessionJsonlFilesIncrementally } from '../rollouts/codex-session-file-listing'
import { linkCodexSessionFile, tryHardlinkCodexSessionFile } from '../rollouts/codex-session-link'
import type { CodexSessionBridgeIncrementalOptions } from '../rollouts/codex-session-file-listing'
import { legacyCopyLocks } from './codex-legacy-session-copy-lock-holder'
import {
  protectLegacySessionCopy,
  settleLegacySessionCopyName,
  swapLegacySessionCopy,
  type LegacySessionCopyReadBudget
} from './codex-legacy-session-copy'
import {
  legacySessionCopyMarkerPath,
  parseLegacyCopiedSessionMarker,
  type LegacyCopiedSessionMarker
} from './codex-legacy-session-copy-marker'

// Legacy copies a background pass may read to check them against their sources.
const LEGACY_COPY_READ_BUDGET_BYTES = 64 * 1024 * 1024

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

  const managedHome = getOrcaManagedCodexHomePath()
  const managedSessionsRoot = join(managedHome, 'sessions')
  const summary: CodexSessionBridgeSummary = { scannedFiles: 0, linkedFiles: 0 }
  const readBudget: LegacySessionCopyReadBudget = {
    bytes: LEGACY_COPY_READ_BUDGET_BYTES,
    limit: LEGACY_COPY_READ_BUDGET_BYTES
  }
  const hasLegacyCopies = existsSync(join(managedHome, '.orca-session-copies'))
  const canPublish = await createCodexRolloutVisibilityPredicate({ includePending: true })
  try {
    for await (const systemSessionFilePath of listCodexSessionJsonlFilesIncrementally(
      systemSessionsRoot,
      options
    )) {
      summary.scannedFiles += 1
      if (!canPublish(systemSessionFilePath)) {
        continue
      }
      const relativePath = relative(systemSessionsRoot, systemSessionFilePath)
      const managedSessionFilePath = join(managedSessionsRoot, relativePath)
      let bridged: boolean | 'existing' | 'missing'
      let mayBeMovedAside = hasLegacyCopies
      do {
        bridged = await bridgeSystemCodexSessionFile(
          systemSessionFilePath,
          managedSessionFilePath,
          relativePath,
          mayBeMovedAside
        )
        if (bridged === 'missing') {
          mayBeMovedAside = false
          const restored = await settleLegacySessionCopyName({ managedHome, relativePath }).then(
            () => true,
            (error: unknown) => {
              console.warn(
                '[codex-session-bridge] Could not restore a legacy copy moved aside:',
                error
              )
              return false
            }
          )
          // Left for a later pass rather than linking the source over a copy that may be aside.
          if (!restored) {
            bridged = false
          }
        }
      } while (bridged === 'missing')
      if (bridged === 'existing') {
        if (hasLegacyCopies && existsSync(legacySessionCopyMarkerPath(managedHome, relativePath))) {
          // Past the read budget a copy waits for a later pass; only its marker is hidden from older builds.
          await withCodexRolloutPublication(systemSessionFilePath, undefined, async () => {
            await (readBudget.exhausted
              ? protectLegacySessionCopy({ managedHome, relativePath })
              : swapLegacySessionCopy({
                  managedHome,
                  relativePath,
                  expectedSourcePath: systemSessionFilePath,
                  readBudget
                }))
          })
        }
      } else if (bridged) {
        summary.linkedFiles += 1
      }
    }
  } finally {
    // The pass's last window lets go now rather than at its timer.
    await legacyCopyLocks.releaseIfIdle()
  }
  return summary
}

async function bridgeSystemCodexSessionFile(
  systemSessionFilePath: string,
  managedSessionFilePath: string,
  relativePath: string,
  mayBeMovedAside = false
): Promise<boolean | 'existing' | 'missing'> {
  if (existsSync(managedSessionFilePath)) {
    return (
      (await replaceSymlinkSessionBridgeWithHardlink(
        systemSessionFilePath,
        managedSessionFilePath,
        relativePath
      )) || 'existing'
    )
  }
  // A swap may have stopped with the copy moved aside: linking the source here would hide its bytes.
  if (mayBeMovedAside) {
    return 'missing'
  }
  return withCodexRolloutPublication(systemSessionFilePath, false, async () => {
    mkdirSync(dirname(managedSessionFilePath), { recursive: true })
    return linkSystemCodexSessionFile(systemSessionFilePath, managedSessionFilePath, relativePath)
  })
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

async function replaceSymlinkSessionBridgeWithHardlink(
  sourcePath: string,
  targetPath: string,
  relativePath: string
): Promise<boolean> {
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

    return await withCodexRolloutPublication(sourcePath, false, async () => {
      replacementPath = `${targetPath}.orca-link-${process.pid}-${Date.now()}`
      if (!tryHardlinkCodexSessionFile(sourcePath, replacementPath)) {
        return false
      }
      rmSync(targetPath, { force: true })
      renameSync(replacementPath, targetPath)
      clearLegacyCopiedSessionMarker(relativePath)
      return true
    })
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
    // Kept markers spell the source with `/./`; skip-byte lookups key on the listed spelling.
    sourcePath: normalize(marker.sourcePath),
    // Legacy copies share a prefix with their source; scan one full log until they become linked.
    preferManagedCopy: !targetMatchesMarker || sourceMatchesMarker,
    sourceSkipBytes: !targetMatchesMarker && !sourceMatchesMarker ? marker.sourceSize : null
  }
}

function readLegacyCopiedSessionMarker(relativePath: string): LegacyCopiedSessionMarker | null {
  try {
    return parseLegacyCopiedSessionMarker(
      readFileSync(
        legacySessionCopyMarkerPath(getOrcaManagedCodexHomePath(), relativePath),
        'utf-8'
      )
    )
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
  rmSync(legacySessionCopyMarkerPath(getOrcaManagedCodexHomePath(), relativePath), { force: true })
}
