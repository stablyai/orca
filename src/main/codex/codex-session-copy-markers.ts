import { createHash } from 'node:crypto'
import {
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { dirname, join } from 'node:path'
import { getOrcaManagedCodexHomePath } from './codex-home-paths'

export type CopiedCodexSessionMarker = {
  version?: 2
  mtimePrecision?: 'milliseconds' | 'seconds'
  sourcePath: string
  sourceSize: number
  sourceMtimeMs: number
  targetSize: number
  targetMtimeMs: number
  targetFingerprintSha256?: string
}

export function copiedCodexSessionMarkerPath(relativePath: string): string {
  return join(getOrcaManagedCodexHomePath(), '.orca-session-copies', `${relativePath}.json`)
}

export function readCopiedCodexSessionMarker(
  relativePath: string
): CopiedCodexSessionMarker | null {
  try {
    const parsed: unknown = JSON.parse(
      readFileSync(copiedCodexSessionMarkerPath(relativePath), 'utf-8')
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
    if (
      (marker.version !== undefined && marker.version !== 2) ||
      (marker.mtimePrecision !== undefined &&
        marker.mtimePrecision !== 'milliseconds' &&
        marker.mtimePrecision !== 'seconds') ||
      (marker.targetFingerprintSha256 !== undefined &&
        (typeof marker.targetFingerprintSha256 !== 'string' ||
          !/^[a-f0-9]{64}$/.test(marker.targetFingerprintSha256)))
    ) {
      return null
    }
    if (
      marker.version === 2 &&
      (marker.mtimePrecision === undefined || marker.targetFingerprintSha256 === undefined)
    ) {
      return null
    }
    return marker as CopiedCodexSessionMarker
  } catch {
    return null
  }
}

export function codexSessionStatsMatchMarker(
  stat: { size: number; mtimeMs: number },
  marker: CopiedCodexSessionMarker,
  kind: 'source' | 'target'
): boolean {
  const expectedSize = kind === 'source' ? marker.sourceSize : marker.targetSize
  const expectedMtimeMs = kind === 'source' ? marker.sourceMtimeMs : marker.targetMtimeMs
  // Why: marker origin is explicit; inferring WSL precision from an exact-second
  // local mtime can misclassify a same-second managed edit as unchanged.
  const mtimeMatches =
    marker.mtimePrecision === 'seconds'
      ? Math.floor(stat.mtimeMs / 1000) === expectedMtimeMs / 1000
      : stat.mtimeMs === expectedMtimeMs
  return stat.size === expectedSize && mtimeMatches
}

export function codexSessionSourceMatchesCopiedPrefix(
  sourcePath: string,
  marker: CopiedCodexSessionMarker,
  expectedFingerprintSha256 = marker.targetFingerprintSha256
): boolean {
  return (
    expectedFingerprintSha256 !== undefined &&
    lstatSync(sourcePath).size >= marker.targetSize &&
    fingerprintCodexSessionFile(sourcePath, marker.targetSize) ===
      expectedFingerprintSha256
  )
}

export function fingerprintCodexSessionFile(filePath: string, maxBytes?: number): string {
  const hash = createHash('sha256')
  const buffer = Buffer.allocUnsafe(64 * 1024)
  const descriptor = openSync(filePath, 'r')
  let remaining = maxBytes ?? Number.POSITIVE_INFINITY
  try {
    while (remaining > 0) {
      const bytesRead = readSync(descriptor, buffer, 0, Math.min(buffer.length, remaining), null)
      if (bytesRead === 0) {
        break
      }
      hash.update(buffer.subarray(0, bytesRead))
      remaining -= bytesRead
    }
  } finally {
    closeSync(descriptor)
  }
  return hash.digest('hex')
}

export function clearCopiedCodexSessionMarker(relativePath: string): void {
  rmSync(copiedCodexSessionMarkerPath(relativePath), { force: true })
}

export function writeCopiedCodexSessionMarker(
  relativePath: string,
  sourcePath: string,
  targetPath: string
): void {
  const sourceStat = lstatSync(sourcePath)
  const targetStat = lstatSync(targetPath)
  const targetFingerprintSha256 = fingerprintCodexSessionFile(targetPath)
  if (
    targetStat.size > sourceStat.size ||
    fingerprintCodexSessionFile(sourcePath, targetStat.size) !== targetFingerprintSha256
  ) {
    throw new Error('Copied Codex session no longer matches its source prefix')
  }
  const markerPath = copiedCodexSessionMarkerPath(relativePath)
  mkdirSync(dirname(markerPath), { recursive: true })
  writeFileSync(
    markerPath,
    `${JSON.stringify(
      {
        version: 2,
        mtimePrecision: 'milliseconds',
        sourcePath,
        // Source may append while it is copied; the target size is the exact
        // source prefix that this marker owns.
        sourceSize: targetStat.size,
        sourceMtimeMs: sourceStat.mtimeMs,
        targetSize: targetStat.size,
        targetMtimeMs: targetStat.mtimeMs,
        targetFingerprintSha256
      } satisfies CopiedCodexSessionMarker,
      null,
      2
    )}\n`,
    'utf-8'
  )
}
