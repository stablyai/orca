export const AI_VAULT_DISCOVERY_MAX_ENTRIES = 100_000
export const AI_VAULT_DISCOVERY_MAX_DEPTH = 64
export const AI_VAULT_DISCOVERY_MAX_PATH_BYTES = 32 * 1024 * 1024

const DISCOVERY_PATH_OVERHEAD_BYTES = 128

export type AiVaultSessionDiscoveryLimits = {
  maxEntries: number
  maxDepth: number
  maxPathBytes: number
}

export class AiVaultSessionDiscoveryCapacityError extends Error {
  constructor() {
    super(
      'AI Vault session discovery stopped at its safety limit (100,000 entries, 64 folder levels, or 32 MiB of path data).'
    )
    this.name = 'AiVaultSessionDiscoveryCapacityError'
  }
}

export class AiVaultSessionDiscoveryBudget {
  private entries = 0
  private pathBytes = 0
  readonly limits: AiVaultSessionDiscoveryLimits

  constructor(requested?: Partial<AiVaultSessionDiscoveryLimits>) {
    this.limits = {
      maxEntries: clampLimit(requested?.maxEntries, AI_VAULT_DISCOVERY_MAX_ENTRIES),
      maxDepth: clampLimit(requested?.maxDepth, AI_VAULT_DISCOVERY_MAX_DEPTH),
      maxPathBytes: clampLimit(requested?.maxPathBytes, AI_VAULT_DISCOVERY_MAX_PATH_BYTES)
    }
  }

  enterDirectory(depth: number): void {
    if (depth > this.limits.maxDepth) {
      throw new AiVaultSessionDiscoveryCapacityError()
    }
  }

  visitEntry(path: string): void {
    const nextPathBytes = this.pathBytes + path.length * 2 + DISCOVERY_PATH_OVERHEAD_BYTES
    if (this.entries >= this.limits.maxEntries || nextPathBytes > this.limits.maxPathBytes) {
      throw new AiVaultSessionDiscoveryCapacityError()
    }
    this.entries += 1
    this.pathBytes = nextPathBytes
  }
}

function clampLimit(value: number | undefined, maximum: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    return maximum
  }
  return Math.min(value, maximum)
}
