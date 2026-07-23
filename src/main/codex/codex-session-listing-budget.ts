export const CODEX_SESSION_LISTING_MAX_DEPTH = 32
export const CODEX_SESSION_LISTING_MAX_ENTRIES = 200_000
export const CODEX_SESSION_LISTING_MAX_FILES = 100_000
export const CODEX_SESSION_LISTING_MAX_PATH_CODE_UNITS = 32 * 1024 * 1024

export type CodexSessionListingLimits = {
  maxDepth: number
  maxEntries: number
  maxFiles: number
  maxPathCodeUnits: number
}

const DEFAULT_LIMITS: CodexSessionListingLimits = {
  maxDepth: CODEX_SESSION_LISTING_MAX_DEPTH,
  maxEntries: CODEX_SESSION_LISTING_MAX_ENTRIES,
  maxFiles: CODEX_SESSION_LISTING_MAX_FILES,
  maxPathCodeUnits: CODEX_SESSION_LISTING_MAX_PATH_CODE_UNITS
}

export type CodexSessionListingCapacityResource = 'depth' | 'entries' | 'files' | 'path code units'

export class CodexSessionListingCapacityError extends Error {
  constructor(
    readonly resource: CodexSessionListingCapacityResource,
    readonly observed: number,
    readonly limit: number
  ) {
    super(`Codex session listing exceeded ${limit} ${resource}`)
    this.name = 'CodexSessionListingCapacityError'
  }
}

export class CodexSessionListingBudget {
  readonly limits: CodexSessionListingLimits
  private entries = 0
  private files = 0
  private pathCodeUnits = 0

  constructor(limits: Partial<CodexSessionListingLimits> = {}) {
    this.limits = { ...DEFAULT_LIMITS, ...limits }
    for (const [name, value] of Object.entries(this.limits)) {
      if (!Number.isSafeInteger(value) || value < 0) {
        throw new RangeError(`${name} must be a non-negative safe integer`)
      }
    }
  }

  claimDepth(depth: number): void {
    if (depth > this.limits.maxDepth) {
      throw new CodexSessionListingCapacityError('depth', depth, this.limits.maxDepth)
    }
  }

  claimEntry(): void {
    this.entries += 1
    if (this.entries > this.limits.maxEntries) {
      throw new CodexSessionListingCapacityError('entries', this.entries, this.limits.maxEntries)
    }
  }

  claimFile(): void {
    this.files += 1
    if (this.files > this.limits.maxFiles) {
      throw new CodexSessionListingCapacityError('files', this.files, this.limits.maxFiles)
    }
  }

  claimPath(path: string): void {
    this.pathCodeUnits += path.length
    if (
      !Number.isSafeInteger(this.pathCodeUnits) ||
      this.pathCodeUnits > this.limits.maxPathCodeUnits
    ) {
      throw new CodexSessionListingCapacityError(
        'path code units',
        this.pathCodeUnits,
        this.limits.maxPathCodeUnits
      )
    }
  }
}
