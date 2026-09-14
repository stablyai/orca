import type { SshPtyModelAdmissionKey } from './ssh-pty-model-admission-contract'
import {
  admissionKeyId,
  pressureHasAdmissionKey,
  takePausedGeneration,
  type AdmissionEntry,
  type PtyUsage
} from './ssh-pty-model-admission-entry'
import type { SshPtyModelAdmissionLimits } from './ssh-pty-model-admission-limits'

type PressureOptions = {
  limits: SshPtyModelAdmissionLimits
  pauseProvider: (key: SshPtyModelAdmissionKey) => boolean
  resumeProvider: (key: SshPtyModelAdmissionKey) => void
}

type PromotionOptions = {
  usageByPty: ReadonlyMap<string, PtyUsage>
  disposed: boolean
  canReserve: (entry: AdmissionEntry) => boolean
  reserve: (entry: AdmissionEntry) => void
  isBelowGlobalLowWatermark: () => boolean
}

export class SshPtyModelAdmissionPressure {
  private readonly entries: AdmissionEntry[] = []
  private readonly pausedKeys = new Map<string, SshPtyModelAdmissionKey>()
  private retainedBytes = 0

  constructor(private readonly options: PressureOptions) {}

  get values(): readonly AdmissionEntry[] {
    return this.entries
  }

  get frameCount(): number {
    return this.entries.length
  }

  get bytes(): number {
    return this.retainedBytes
  }

  get pausedPtyCount(): number {
    return this.pausedKeys.size
  }

  get pausedProviderGenerations(): ReadonlySet<number> {
    return new Set(Array.from(this.pausedKeys.values(), (key) => key.providerGeneration))
  }

  has(key: SshPtyModelAdmissionKey): boolean {
    return pressureHasAdmissionKey(this.entries, key)
  }

  admit(entry: AdmissionEntry): boolean {
    const id = admissionKeyId(entry.key)
    const paused = this.pausedKeys.has(id) || this.options.pauseProvider(entry.key)
    if (paused) {
      this.pausedKeys.set(id, entry.key)
    }
    if (
      !paused ||
      this.entries.length >= this.options.limits.pressureMaxFrames ||
      this.retainedBytes + entry.charge.bytes > this.options.limits.pressureMaxBytes
    ) {
      return false
    }
    entry.state = 'pressure'
    this.entries.push(entry)
    this.retainedBytes += entry.charge.bytes
    return true
  }

  cancelGeneration(
    providerGeneration: number,
    cancelPressureAndReserved: (entries: AdmissionEntry[]) => number
  ): void {
    this.retainedBytes -= cancelPressureAndReserved(this.entries)
    for (const key of takePausedGeneration(this.pausedKeys, providerGeneration)) {
      this.resume(key)
    }
  }

  cancelPty(key: SshPtyModelAdmissionKey, error: Error, cancelReserved: () => void): void {
    this.cancelQueuedPty(key, error)
    cancelReserved()
  }

  cancelQueuedPty(key: SshPtyModelAdmissionKey, error: Error): void {
    const id = admissionKeyId(key)
    const canceled: AdmissionEntry[] = []
    for (let index = this.entries.length - 1; index >= 0; index--) {
      if (admissionKeyId(this.entries[index]!.key) === id) {
        canceled.push(this.entries.splice(index, 1)[0]!)
      }
    }
    this.rejectPressureEntries(canceled, error)
    const paused = this.pausedKeys.get(id)
    if (paused) {
      this.pausedKeys.delete(id)
      this.resume(paused)
    }
  }

  promoteAndResume(options: PromotionOptions): void {
    if (options.disposed) {
      return
    }
    for (let index = 0; index < this.entries.length;) {
      const entry = this.entries[index]!
      const hasEarlierEntryForPty = this.entries
        .slice(0, index)
        .some((earlier) => admissionKeyId(earlier.key) === admissionKeyId(entry.key))
      if (hasEarlierEntryForPty || !options.canReserve(entry)) {
        index++
        continue
      }
      this.entries.splice(index, 1)
      this.retainedBytes -= entry.charge.bytes
      options.reserve(entry)
    }
    if (!options.isBelowGlobalLowWatermark()) {
      return
    }
    for (const [id, key] of this.pausedKeys) {
      const usage = options.usageByPty.get(id)
      if (
        this.has(key) ||
        (usage?.sourceUnits ?? 0) > this.options.limits.perPtyLowSourceUnits ||
        (usage?.bytes ?? 0) > this.options.limits.perPtyLowBytes
      ) {
        continue
      }
      this.pausedKeys.delete(id)
      this.resume(key)
    }
  }

  private rejectPressureEntries(entries: readonly AdmissionEntry[], error: Error): void {
    for (const entry of entries) {
      this.retainedBytes -= entry.charge.bytes
      entry.state = 'settled'
      entry.reject(error)
    }
  }

  private resume(key: SshPtyModelAdmissionKey): void {
    try {
      this.options.resumeProvider(key)
    } catch {}
  }
}
