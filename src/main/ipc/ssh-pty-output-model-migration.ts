import type {
  SshPtyAcceptedSourceCheckpoint,
  SshPtyOutputSourceObligations
} from './ssh-pty-output-source-obligations'
import type { SshPtyModelAdmissionKey } from './ssh-pty-model-admission-contract'
import type { SshPtyModelAdmission } from './ssh-pty-model-admission'

export const SSH_PTY_MODEL_MIGRATION_TIMEOUT_MS = 10_000

export type SshPtyOutputMigrationResult =
  | Readonly<{ status: 'settled'; checkpoint: SshPtyAcceptedSourceCheckpoint }>
  | Readonly<{ status: 'checkpoint-unavailable'; reason: 'completion-failed' | 'timeout' }>

export type SshPtyOutputGenerationMigration = Readonly<{
  byPty: ReadonlyMap<string, Promise<SshPtyOutputMigrationResult>>
  completion: Promise<void>
}>

export type SshPtyTrackedModelAdmission = {
  readonly key: SshPtyModelAdmissionKey
  started: boolean
  completion?: Promise<unknown>
}

export class SshPtyOutputModelMigration {
  private readonly pendingByPty = new Map<string, Set<SshPtyTrackedModelAdmission>>()

  constructor(
    private readonly admission: SshPtyModelAdmission,
    private readonly sourceObligations: SshPtyOutputSourceObligations,
    private readonly resetModel: (providerGeneration: number, ptyId: string) => void
  ) {}

  track(record: SshPtyTrackedModelAdmission): void {
    const id = migrationKey(record.key)
    const records = this.pendingByPty.get(id) ?? new Set<SshPtyTrackedModelAdmission>()
    records.add(record)
    this.pendingByPty.set(id, records)
    record.completion?.then(
      () => this.remove(id, record),
      () => this.remove(id, record)
    )
  }

  beginGeneration(
    providerGeneration: number,
    timeoutMs = SSH_PTY_MODEL_MIGRATION_TIMEOUT_MS
  ): SshPtyOutputGenerationMigration {
    const checkpoints = this.sourceObligations.acceptedCheckpoints(providerGeneration)
    const keys = checkpoints.map((checkpoint) => ({
      ptyId: checkpoint.id,
      providerGeneration
    }))
    for (const key of keys) {
      this.admission.beginMigration(key)
    }
    const byPty = new Map<string, Promise<SshPtyOutputMigrationResult>>()
    for (const key of keys) {
      byPty.set(key.ptyId, this.settlePty(key, timeoutMs))
    }
    const completion = Promise.allSettled(byPty.values()).then(() => {})
    return Object.freeze({ byPty, completion })
  }

  private async settlePty(
    key: SshPtyModelAdmissionKey,
    timeoutMs: number
  ): Promise<SshPtyOutputMigrationResult> {
    const running = Array.from(this.pendingByPty.get(migrationKey(key)) ?? []).find(
      (record) => record.started
    )
    if (!running?.completion) {
      return this.settledCheckpoint(key)
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), normalizedTimeout(timeoutMs))
      timer.unref?.()
    })
    try {
      const outcome = await Promise.race([
        running.completion.then(
          () => 'settled' as const,
          () => 'failed' as const
        ),
        timeout
      ])
      if (outcome === 'settled') {
        return this.settledCheckpoint(key)
      }
      const reason = outcome === 'timeout' ? 'timeout' : 'completion-failed'
      this.resetModel(key.providerGeneration, key.ptyId)
      this.admission.cancelPty(key, `ssh_model_migration_${reason}`)
      if (outcome === 'timeout') {
        await running.completion.catch(() => {})
      }
      return Object.freeze({ status: 'checkpoint-unavailable', reason })
    } finally {
      if (timer) {
        clearTimeout(timer)
      }
    }
  }

  private settledCheckpoint(key: SshPtyModelAdmissionKey): SshPtyOutputMigrationResult {
    const checkpoint = this.sourceObligations.acceptedCheckpoint(key)
    if (!checkpoint) {
      this.resetModel(key.providerGeneration, key.ptyId)
      return Object.freeze({
        status: 'checkpoint-unavailable',
        reason: 'completion-failed'
      })
    }
    return Object.freeze({ status: 'settled', checkpoint })
  }

  private remove(id: string, record: SshPtyTrackedModelAdmission): void {
    const records = this.pendingByPty.get(id)
    records?.delete(record)
    if (records?.size === 0) {
      this.pendingByPty.delete(id)
    }
  }
}

function migrationKey(key: SshPtyModelAdmissionKey): string {
  return `${key.providerGeneration}\0${key.ptyId}`
}

function normalizedTimeout(timeoutMs: number): number {
  return Number.isFinite(timeoutMs) && timeoutMs >= 0
    ? Math.floor(timeoutMs)
    : SSH_PTY_MODEL_MIGRATION_TIMEOUT_MS
}
