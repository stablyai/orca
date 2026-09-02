import type {
  SshPtyModelAdmissionKey,
  SshPtyModelAdmissionOptions,
  SshPtyModelAdmissionReceipt
} from './ssh-pty-model-admission-contract'
import {
  admissionError,
  admissionKeyId,
  canReserveAdmission,
  cancelAdmissionGeneration,
  retainedBytes,
  resolveAdmissionIdleWaiters,
  type AdmissionCharge,
  type AdmissionEntry,
  type PtyUsage
} from './ssh-pty-model-admission-entry'
import { resolveSshPtyModelAdmissionLimits } from './ssh-pty-model-admission-limits'
import * as modelAdmissionMigration from './ssh-pty-model-admission-migration'
import { SshPtyModelAdmissionPressure } from './ssh-pty-model-admission-pressure'
import { sshPtyModelAdmissionSnapshot } from './ssh-pty-model-admission-snapshot'

export type * from './ssh-pty-model-admission-contract'

export class SshPtyModelAdmission {
  private readonly limits: ReturnType<typeof resolveSshPtyModelAdmissionLimits>
  private readonly closeProvider: (providerGeneration: number, reason: string) => void
  private readonly usageByPty = new Map<string, PtyUsage>()
  private readonly pressure: SshPtyModelAdmissionPressure
  private readonly idleWaiters = new Map<string, Set<() => void>>()
  private readonly closingGenerations = new Set<number>()
  private readonly migratingPtys = new Set<string>()
  private globalSourceUnits = 0
  private globalBytes = 0
  private disposed = false

  constructor(options: SshPtyModelAdmissionOptions = {}) {
    this.limits = resolveSshPtyModelAdmissionLimits(options)
    this.pressure = new SshPtyModelAdmissionPressure({
      limits: this.limits,
      pauseProvider: options.pauseProvider ?? (() => false),
      resumeProvider: options.resumeProvider ?? (() => {})
    })
    this.closeProvider = options.closeProvider ?? (() => {})
  }

  accept(
    key: SshPtyModelAdmissionKey,
    data: string,
    sourceUnits: number,
    run: () => { sequence: number; completion: Promise<void> }
  ): Promise<SshPtyModelAdmissionReceipt> {
    if (this.disposed) {
      return Promise.reject(admissionError('ssh_model_admission_disposed'))
    }
    if (this.closingGenerations.has(key.providerGeneration)) {
      return Promise.reject(admissionError('ssh_model_admission_generation_closed'))
    }
    if (this.migratingPtys.has(admissionKeyId(key))) {
      return Promise.reject(admissionError('ssh_model_admission_migrating'))
    }
    const charge = { sourceUnits, bytes: retainedBytes(data) }
    return new Promise((resolve, reject) => {
      const entry: AdmissionEntry = {
        key: { ...key },
        charge,
        run,
        resolve,
        reject,
        state: 'queued'
      }
      if (this.canReserve(key, charge) && !this.pressure.has(key)) {
        this.reserveAndQueue(entry)
        return
      }
      if (!this.pressure.admit(entry)) {
        entry.reject(admissionError('ssh_model_admission_pressure_exhausted'))
        this.closeProvider(entry.key.providerGeneration, 'model-admission-pressure')
      }
    })
  }

  closeGeneration(providerGeneration: number, reason = 'provider-generation-closed'): void {
    this.closingGenerations.add(providerGeneration)
    const error = admissionError(reason)
    this.pressure.cancelGeneration(providerGeneration, (pressure) =>
      cancelAdmissionGeneration({
        pressure,
        usageByPty: this.usageByPty,
        idleWaiters: this.idleWaiters,
        providerGeneration,
        error,
        release: (key, charge) => this.release(key, charge)
      })
    )
    modelAdmissionMigration.closeSshPtyModelAdmissionMigrations(
      this.migratingPtys,
      providerGeneration
    )
    const generationPrefix = `${providerGeneration}\0`
    for (const id of this.idleWaiters.keys()) {
      if (id.startsWith(generationPrefix)) {
        resolveAdmissionIdleWaiters(this.usageByPty, this.pressure.values, this.idleWaiters, id)
      }
    }
  }

  beginMigration(key: SshPtyModelAdmissionKey): void {
    modelAdmissionMigration.beginSshPtyModelAdmissionMigration({
      key,
      migratingPtys: this.migratingPtys,
      pressure: this.pressure,
      usageByPty: this.usageByPty,
      release: (entryKey, charge) => this.release(entryKey, charge),
      cleanup: (id, usage) => this.cleanupUsage(id, usage)
    })
    const id = admissionKeyId(key)
    resolveAdmissionIdleWaiters(this.usageByPty, this.pressure.values, this.idleWaiters, id)
  }

  cancelPty(key: SshPtyModelAdmissionKey, reason: string): void {
    const id = admissionKeyId(key)
    const error = admissionError(reason)
    this.pressure.cancelPty(key, error, () => {
      const usage = this.usageByPty.get(id)
      if (usage) {
        const canceled = [...usage.queued, ...(usage.running ? [usage.running] : [])]
        usage.queued = []
        usage.running = null
        for (const entry of canceled) {
          if (entry.state === 'settled') {
            continue
          }
          entry.state = 'settled'
          this.release(entry.key, entry.charge)
          entry.reject(error)
        }
        this.usageByPty.delete(id)
      }
    })
    resolveAdmissionIdleWaiters(this.usageByPty, this.pressure.values, this.idleWaiters, id)
  }

  whenIdle(key: SshPtyModelAdmissionKey): Promise<void> {
    const id = admissionKeyId(key)
    const usage = this.usageByPty.get(id)
    const hasPressure = this.pressure.has(key)
    if ((!usage || (!usage.running && usage.queued.length === 0)) && !hasPressure) {
      return Promise.resolve()
    }
    return new Promise((resolve) => {
      const waiters = this.idleWaiters.get(id) ?? new Set<() => void>()
      waiters.add(resolve)
      this.idleWaiters.set(id, waiters)
    })
  }

  dispose(): void {
    if (this.disposed) {
      return
    }
    this.disposed = true
    const generations = new Set<number>()
    for (const usage of this.usageByPty.values()) {
      if (usage.running) {
        generations.add(usage.running.key.providerGeneration)
      }
      for (const entry of usage.queued) {
        generations.add(entry.key.providerGeneration)
      }
    }
    for (const entry of this.pressure.values) {
      generations.add(entry.key.providerGeneration)
    }
    for (const generation of this.pressure.pausedProviderGenerations) {
      generations.add(generation)
    }
    for (const generation of generations) {
      this.closeGeneration(generation, 'ssh_model_admission_disposed')
    }
  }

  getDebugSnapshot() {
    return sshPtyModelAdmissionSnapshot(
      this.globalSourceUnits,
      this.globalBytes,
      this.pressure,
      this.migratingPtys
    )
  }

  private canReserve(key: SshPtyModelAdmissionKey, charge: AdmissionCharge): boolean {
    if (this.migratingPtys.has(admissionKeyId(key))) {
      return false
    }
    return canReserveAdmission({
      key,
      charge,
      limits: this.limits,
      usageByPty: this.usageByPty,
      closingGenerations: this.closingGenerations,
      globalSourceUnits: this.globalSourceUnits,
      globalBytes: this.globalBytes
    })
  }

  private reserveAndQueue(entry: AdmissionEntry): void {
    const id = admissionKeyId(entry.key)
    let usage = this.usageByPty.get(id)
    if (!usage) {
      usage = { sourceUnits: 0, bytes: 0, queued: [], running: null }
      this.usageByPty.set(id, usage)
    }
    usage.sourceUnits += entry.charge.sourceUnits
    usage.bytes += entry.charge.bytes
    this.globalSourceUnits += entry.charge.sourceUnits
    this.globalBytes += entry.charge.bytes
    entry.state = 'queued'
    usage.queued.push(entry)
    this.startNext(id, usage)
  }

  private startNext(id: string, usage: PtyUsage): void {
    if (usage.running) {
      return
    }
    const entry = usage.queued.shift()
    if (!entry) {
      this.promotePressureAndResumeProvider()
      return
    }
    usage.running = entry
    entry.state = 'running'
    let execution: { sequence: number; completion: Promise<void> }
    try {
      execution = entry.run()
    } catch (error) {
      if (this.finishEntry(id, usage, entry)) {
        entry.reject(error instanceof Error ? error : new Error(String(error)))
      }
      return
    }
    void execution.completion.then(
      () => {
        if (!this.finishEntry(id, usage, entry)) {
          return
        }
        entry.resolve({
          ptyId: entry.key.ptyId,
          providerGeneration: entry.key.providerGeneration,
          sequence: execution.sequence
        })
      },
      (error) => {
        this.failEntry(id, usage, entry, error instanceof Error ? error : new Error(String(error)))
      }
    )
  }

  private failEntry(id: string, usage: PtyUsage, entry: AdmissionEntry, error: Error): void {
    modelAdmissionMigration.settleSshPtyModelAdmissionFailure({
      id,
      usage,
      entry,
      error,
      migratingPtys: this.migratingPtys,
      closingGenerations: this.closingGenerations,
      release: (key, charge) => this.release(key, charge),
      closeGeneration: (providerGeneration) =>
        this.closeGeneration(providerGeneration, 'ssh_model_admission_completion_failed'),
      cleanup: (entryId, entryUsage) => this.cleanupUsage(entryId, entryUsage)
    })
  }

  private finishEntry(id: string, usage: PtyUsage, entry: AdmissionEntry): boolean {
    if (entry.state !== 'running' || usage.running !== entry) {
      return false
    }
    usage.running = null
    entry.state = 'settled'
    this.release(entry.key, entry.charge)
    this.cleanupUsage(id, usage)
    return true
  }

  private cleanupUsage(id: string, usage: PtyUsage): void {
    this.startNext(id, usage)
    if (!usage.running && usage.queued.length === 0 && usage.sourceUnits === 0) {
      this.usageByPty.delete(id)
    }
    resolveAdmissionIdleWaiters(this.usageByPty, this.pressure.values, this.idleWaiters, id)
  }

  private release(key: SshPtyModelAdmissionKey, charge: AdmissionCharge): void {
    const usage = this.usageByPty.get(admissionKeyId(key))
    if (usage) {
      usage.sourceUnits = Math.max(0, usage.sourceUnits - charge.sourceUnits)
      usage.bytes = Math.max(0, usage.bytes - charge.bytes)
    }
    this.globalSourceUnits = Math.max(0, this.globalSourceUnits - charge.sourceUnits)
    this.globalBytes = Math.max(0, this.globalBytes - charge.bytes)
    this.promotePressureAndResumeProvider()
  }

  private promotePressureAndResumeProvider(): void {
    this.pressure.promoteAndResume({
      usageByPty: this.usageByPty,
      disposed: this.disposed,
      canReserve: (entry) => this.canReserve(entry.key, entry.charge),
      reserve: (entry) => this.reserveAndQueue(entry),
      isBelowGlobalLowWatermark: () =>
        this.globalSourceUnits <= this.limits.globalLowSourceUnits &&
        this.globalBytes <= this.limits.globalLowBytes
    })
  }
}
