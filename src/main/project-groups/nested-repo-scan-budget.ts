export const NESTED_REPO_SCAN_MAX_ENTRIES = 100_000
export const NESTED_REPO_SCAN_MAX_PATH_BYTES = 32 * 1024 * 1024
export const NESTED_REPO_SCAN_MAX_IGNORE_RULES = 100_000
export const NESTED_REPO_SCAN_MAX_IGNORE_BYTES = 8 * 1024 * 1024

const NESTED_REPO_ENTRY_OVERHEAD_BYTES = 256
const NESTED_REPO_IGNORE_RULE_OVERHEAD_BYTES = 128

export type NestedRepoScanLimits = {
  maxEntries: number
  maxIgnoreBytes: number
  maxIgnoreRules: number
  maxPathBytes: number
}

export class NestedRepoScanBudget {
  private entries = 0
  private ignoreBytes = 0
  private ignoreRules = 0
  private pathBytes = 0
  readonly limits: NestedRepoScanLimits
  capacityReached = false

  constructor(requested?: Partial<NestedRepoScanLimits>) {
    this.limits = {
      maxEntries: clampLimit(requested?.maxEntries, NESTED_REPO_SCAN_MAX_ENTRIES),
      maxIgnoreBytes: clampLimit(requested?.maxIgnoreBytes, NESTED_REPO_SCAN_MAX_IGNORE_BYTES),
      maxIgnoreRules: clampLimit(requested?.maxIgnoreRules, NESTED_REPO_SCAN_MAX_IGNORE_RULES),
      maxPathBytes: clampLimit(requested?.maxPathBytes, NESTED_REPO_SCAN_MAX_PATH_BYTES)
    }
  }

  tryVisitEntry(path: string): boolean {
    const nextPathBytes = this.pathBytes + path.length * 2 + NESTED_REPO_ENTRY_OVERHEAD_BYTES
    if (this.entries >= this.limits.maxEntries || nextPathBytes > this.limits.maxPathBytes) {
      this.capacityReached = true
      return false
    }
    this.entries += 1
    this.pathBytes = nextPathBytes
    return true
  }

  tryRetainIgnoreRule(pattern: string): boolean {
    const nextBytes = this.ignoreBytes + pattern.length * 2 + NESTED_REPO_IGNORE_RULE_OVERHEAD_BYTES
    if (this.ignoreRules >= this.limits.maxIgnoreRules || nextBytes > this.limits.maxIgnoreBytes) {
      this.capacityReached = true
      return false
    }
    this.ignoreRules += 1
    this.ignoreBytes = nextBytes
    return true
  }
}

function clampLimit(value: number | undefined, maximum: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    return maximum
  }
  return Math.min(value, maximum)
}
