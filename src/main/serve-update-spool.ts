import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  getHelperMarkerPath,
  getRequestPath,
  getResultPath,
  parseServeUpdateHelperMarker,
  parseServeUpdateResult,
  type ServeUpdateHelperMarker,
  type ServeUpdateRequest,
  type ServeUpdateResult,
  type ServeUpdateVerdict
} from '../shared/serve-update-spool'

export const DEFAULT_SERVE_UPDATE_SPOOL_DIR = '/var/lib/orca-server-update'
export const DEFAULT_SERVE_UPDATE_UNIT_NAME = 'orca-serve.service'

function resolveSpoolDir(): string {
  return process.env.ORCA_SERVE_UPDATE_SPOOL_DIR ?? DEFAULT_SERVE_UPDATE_SPOOL_DIR
}

function resolveUnitName(): string {
  return process.env.ORCA_SERVE_UPDATE_UNIT_NAME ?? DEFAULT_SERVE_UPDATE_UNIT_NAME
}

/** The unit name the spooled request names; tests override via ORCA_SERVE_UPDATE_UNIT_NAME. */
export function getServeUpdateUnitName(): string {
  return resolveUnitName()
}

function writeJsonFile(path: string, value: unknown, mode: number): boolean {
  const temporaryPath = `${path}.${process.pid}.tmp`
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(temporaryPath, JSON.stringify(value), { mode })
    renameSync(temporaryPath, path)
    return true
  } catch {
    try {
      unlinkSync(temporaryPath)
    } catch {
      // The rename either succeeded or the original error is the one to report.
    }
    return false
  }
}

export function writeUpdateRequest(request: Omit<ServeUpdateRequest, 'schemaVersion'>): boolean {
  return writeJsonFile(getRequestPath(resolveSpoolDir()), { schemaVersion: 2, ...request }, 0o664)
}

/** Captured download metadata the spooled request carries; the helper re-hashes independently. */
export type ServeUpdateSpoolArtifact = {
  artifactPath: string
  sha512: string
  targetVersion: string
}

export function clearUpdateRequest(): void {
  try {
    unlinkSync(getRequestPath(resolveSpoolDir()))
  } catch {
    // A missing request file is the converged state.
  }
}

export function readUpdateResult(): ServeUpdateResult | null {
  try {
    return parseServeUpdateResult(
      JSON.parse(readFileSync(getResultPath(resolveSpoolDir()), 'utf8'))
    )
  } catch {
    return null
  }
}

export function clearUpdateResult(): void {
  try {
    unlinkSync(getResultPath(resolveSpoolDir()))
  } catch {
    // A missing result file is the converged state.
  }
}

export function readServeUpdateResultFor(
  runtimeId: string,
  targetVersion: string
): { verdict: ServeUpdateVerdict; message: string } | null {
  // Why: the result must describe THIS install attempt, not a stale verdict left by a
  // previous boot. The helper echoes the runtimeId and targetVersion from the request.
  try {
    const raw = JSON.parse(readFileSync(getResultPath(resolveSpoolDir()), 'utf8')) as Record<
      string,
      unknown
    >
    if (raw.runtimeId !== runtimeId) {
      return null
    }
    if (raw.targetVersion !== targetVersion) {
      return null
    }
    const result = parseServeUpdateResult(raw)
    if (!result) {
      return null
    }
    if (result.phase === 'accepted') {
      return { verdict: 'accepted', message: '' }
    }
    if (result.phase === 'ok') {
      return { verdict: 'accepted', message: '' }
    }
    if (result.phase === 'rejected') {
      return { verdict: 'rejected', message: `Update rejected: ${result.reason}` }
    }
    return { verdict: 'failed', message: `Update failed: ${result.reason}` }
  } catch {
    return null
  }
}

let cachedHelperVerdict: boolean | undefined

/** Once-per-process, mirroring getLinuxPackageType's caching discipline. */
export function hasLinuxServeUpdateHelper(): boolean {
  if (cachedHelperVerdict === undefined) {
    const marker = readHelperMarker()
    cachedHelperVerdict =
      marker !== null &&
      marker.unitName === resolveUnitName() &&
      marker.helperVersion >= MINIMUM_HELPER_VERSION
  }
  return cachedHelperVerdict
}

export const MINIMUM_HELPER_VERSION = 1

export function readHelperMarker(): ServeUpdateHelperMarker | null {
  try {
    return parseServeUpdateHelperMarker(
      JSON.parse(readFileSync(getHelperMarkerPath(resolveSpoolDir()), 'utf8'))
    )
  } catch {
    return null
  }
}

/** Test seam: the verdict is once-per-process by design. */
export function resetLinuxServeUpdateHelperCache(): void {
  cachedHelperVerdict = undefined
}
