export const LEGACY_OMP_OVERLAY_MIGRATION_MAX_ENTRIES = 100_000
export const LEGACY_OMP_OVERLAY_MIGRATION_MAX_DEPTH = 256
export const LEGACY_OMP_OVERLAY_MIGRATION_MAX_PATH_BYTES = 64 * 1_024
export const LEGACY_OMP_OVERLAY_MIGRATION_MAX_RETAINED_PATH_BYTES = 16 * 1_024 * 1_024

export type LegacyOverlayMigrationLimits = {
  maxDepth: number
  maxEntries: number
  maxPathBytes: number
  maxRetainedPathBytes: number
}

const DEFAULT_LIMITS: LegacyOverlayMigrationLimits = {
  maxDepth: LEGACY_OMP_OVERLAY_MIGRATION_MAX_DEPTH,
  maxEntries: LEGACY_OMP_OVERLAY_MIGRATION_MAX_ENTRIES,
  maxPathBytes: LEGACY_OMP_OVERLAY_MIGRATION_MAX_PATH_BYTES,
  maxRetainedPathBytes: LEGACY_OMP_OVERLAY_MIGRATION_MAX_RETAINED_PATH_BYTES
}

export class LegacyOverlayMigrationCapacityError extends Error {
  constructor(kind: string, observed: number, limit: number) {
    super(`Legacy OMP overlay ${kind} exceeded its ${limit} limit (observed ${observed})`)
    this.name = 'LegacyOverlayMigrationCapacityError'
  }
}

export class LegacyOverlayMigrationBudget {
  private entries = 0
  private retainedPathBytes = 0
  readonly limits: LegacyOverlayMigrationLimits

  constructor(requested?: Partial<LegacyOverlayMigrationLimits>) {
    this.limits = {
      maxDepth: resolveLimit(requested?.maxDepth, DEFAULT_LIMITS.maxDepth, 'maxDepth'),
      maxEntries: resolveLimit(requested?.maxEntries, DEFAULT_LIMITS.maxEntries, 'maxEntries'),
      maxPathBytes: resolveLimit(
        requested?.maxPathBytes,
        DEFAULT_LIMITS.maxPathBytes,
        'maxPathBytes'
      ),
      maxRetainedPathBytes: resolveLimit(
        requested?.maxRetainedPathBytes,
        DEFAULT_LIMITS.maxRetainedPathBytes,
        'maxRetainedPathBytes'
      )
    }
  }

  visit(depth: number, ...paths: string[]): void {
    const nextEntries = this.entries + 1
    if (nextEntries > this.limits.maxEntries) {
      throw new LegacyOverlayMigrationCapacityError('entries', nextEntries, this.limits.maxEntries)
    }
    if (depth > this.limits.maxDepth) {
      throw new LegacyOverlayMigrationCapacityError('depth', depth, this.limits.maxDepth)
    }
    for (const path of paths) {
      this.measurePath(path)
    }
    this.entries = nextEntries
  }

  retainPaths(...paths: string[]): number {
    const retainedBytes = paths.reduce((total, path) => total + this.measurePath(path), 0)
    const nextRetainedBytes = this.retainedPathBytes + retainedBytes
    if (nextRetainedBytes > this.limits.maxRetainedPathBytes) {
      throw new LegacyOverlayMigrationCapacityError(
        'retained-path-bytes',
        nextRetainedBytes,
        this.limits.maxRetainedPathBytes
      )
    }
    this.retainedPathBytes = nextRetainedBytes
    return retainedBytes
  }

  releasePaths(retainedBytes: number): void {
    this.retainedPathBytes = Math.max(0, this.retainedPathBytes - retainedBytes)
  }

  private measurePath(path: string): number {
    const bytes = Buffer.byteLength(path, 'utf8')
    if (bytes > this.limits.maxPathBytes) {
      throw new LegacyOverlayMigrationCapacityError('path-bytes', bytes, this.limits.maxPathBytes)
    }
    return bytes
  }
}

function resolveLimit(requested: number | undefined, maximum: number, name: string): number {
  if (requested === undefined) {
    return maximum
  }
  if (!Number.isSafeInteger(requested) || requested < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`)
  }
  return Math.min(requested, maximum)
}
