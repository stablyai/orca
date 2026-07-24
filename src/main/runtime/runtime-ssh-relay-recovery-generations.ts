import { measureUtf8ByteLength } from '../../shared/utf8-byte-limits'

export const MAX_RUNTIME_SSH_RELAY_RECOVERIES = 256
export const MAX_RUNTIME_SSH_RELAY_RECOVERY_TARGET_ID_BYTES = 64 * 1024
export const MAX_RUNTIME_SSH_RELAY_RECOVERY_RETAINED_TARGET_ID_BYTES = 4 * 1024 * 1024

export type RuntimeSshRelayRecoveryGenerationBounds = {
  maxRecoveries: number
  maxTargetIdBytes: number
  maxRetainedTargetIdBytes: number
}

export type RuntimeSshRelayRecoveryGenerationLease = {
  isCurrent: () => boolean
  release: () => void
}

const DEFAULT_BOUNDS: RuntimeSshRelayRecoveryGenerationBounds = {
  maxRecoveries: MAX_RUNTIME_SSH_RELAY_RECOVERIES,
  maxTargetIdBytes: MAX_RUNTIME_SSH_RELAY_RECOVERY_TARGET_ID_BYTES,
  maxRetainedTargetIdBytes: MAX_RUNTIME_SSH_RELAY_RECOVERY_RETAINED_TARGET_ID_BYTES
}

type RetainedRecovery = {
  generation: number
  targetIdBytes: number
}

export class RuntimeSshRelayRecoveryGenerations {
  private readonly generationByTargetId = new Map<string, RetainedRecovery>()
  private activeRecoveries = 0
  private retainedTargetIdBytes = 0
  private nextGeneration = 1

  constructor(private readonly bounds: RuntimeSshRelayRecoveryGenerationBounds = DEFAULT_BOUNDS) {
    if (
      !Number.isSafeInteger(bounds.maxRecoveries) ||
      bounds.maxRecoveries < 1 ||
      !Number.isSafeInteger(bounds.maxTargetIdBytes) ||
      bounds.maxTargetIdBytes < 1 ||
      !Number.isSafeInteger(bounds.maxRetainedTargetIdBytes) ||
      bounds.maxRetainedTargetIdBytes < 1
    ) {
      throw new RangeError('SSH relay recovery generation bounds must be positive integers')
    }
  }

  begin(targetId: string): RuntimeSshRelayRecoveryGenerationLease | null {
    const targetIdMeasurement = measureUtf8ByteLength(targetId, {
      stopAfterBytes: this.bounds.maxTargetIdBytes
    })
    if (targetIdMeasurement.exceededLimit) {
      return null
    }
    if (
      this.activeRecoveries >= this.bounds.maxRecoveries ||
      this.retainedTargetIdBytes + targetIdMeasurement.byteLength >
        this.bounds.maxRetainedTargetIdBytes
    ) {
      return null
    }
    if (!Number.isSafeInteger(this.nextGeneration)) {
      throw new Error('SSH relay recovery generation exhausted')
    }
    const generation = this.nextGeneration
    this.nextGeneration += 1
    const retained = {
      generation,
      targetIdBytes: targetIdMeasurement.byteLength
    }
    this.generationByTargetId.set(targetId, retained)
    this.activeRecoveries += 1
    this.retainedTargetIdBytes += retained.targetIdBytes
    let active = true
    return {
      isCurrent: () =>
        active &&
        this.generationByTargetId.get(targetId) === retained &&
        retained.generation === generation,
      release: () => {
        if (!active) {
          return
        }
        active = false
        this.releaseLease(targetId, retained)
      }
    }
  }

  invalidate(targetId: string): void {
    this.generationByTargetId.delete(targetId)
  }

  evidence(): { recoveries: number; retainedTargetIdBytes: number } {
    return {
      recoveries: this.activeRecoveries,
      retainedTargetIdBytes: this.retainedTargetIdBytes
    }
  }

  private releaseLease(targetId: string, retained: RetainedRecovery): void {
    this.activeRecoveries -= 1
    this.retainedTargetIdBytes -= retained.targetIdBytes
    if (this.generationByTargetId.get(targetId) === retained) {
      this.generationByTargetId.delete(targetId)
    }
  }
}
