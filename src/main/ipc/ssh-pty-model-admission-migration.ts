import type { SshPtyModelAdmissionKey } from './ssh-pty-model-admission-contract'
import type { AdmissionCharge, AdmissionEntry, PtyUsage } from './ssh-pty-model-admission-entry'
import { admissionError, admissionKeyId } from './ssh-pty-model-admission-entry'
import type { SshPtyModelAdmissionPressure } from './ssh-pty-model-admission-pressure'

export function beginSshPtyModelAdmissionMigration(args: {
  key: SshPtyModelAdmissionKey
  migratingPtys: Set<string>
  pressure: SshPtyModelAdmissionPressure
  usageByPty: Map<string, PtyUsage>
  release: (key: SshPtyModelAdmissionKey, charge: AdmissionCharge) => void
  cleanup: (id: string, usage: PtyUsage) => void
}): void {
  const id = admissionKeyId(args.key)
  if (args.migratingPtys.has(id)) {
    return
  }
  args.migratingPtys.add(id)
  const error = admissionError('ssh_model_migration_queued_canceled')
  args.pressure.cancelQueuedPty(args.key, error)
  const usage = args.usageByPty.get(id)
  if (!usage) {
    return
  }
  const queued = usage.queued
  usage.queued = []
  for (const entry of queued) {
    cancelQueuedEntry(entry, error, args.release)
  }
  args.cleanup(id, usage)
}

export function closeSshPtyModelAdmissionMigrations(
  migratingPtys: Set<string>,
  providerGeneration: number
): void {
  const prefix = `${providerGeneration}\0`
  for (const id of migratingPtys) {
    if (id.startsWith(prefix)) {
      migratingPtys.delete(id)
    }
  }
}

export function settleSshPtyModelAdmissionFailure(args: {
  id: string
  usage: PtyUsage
  entry: AdmissionEntry
  error: Error
  migratingPtys: ReadonlySet<string>
  closingGenerations: Set<number>
  release: (key: SshPtyModelAdmissionKey, charge: AdmissionCharge) => void
  closeGeneration: (providerGeneration: number) => void
  cleanup: (id: string, usage: PtyUsage) => void
}): void {
  if (args.entry.state !== 'running' || args.usage.running !== args.entry) {
    return
  }
  const migrationOwnsFailure = args.migratingPtys.has(args.id)
  if (!migrationOwnsFailure) {
    args.closingGenerations.add(args.entry.key.providerGeneration)
  }
  args.usage.running = null
  args.entry.state = 'settled'
  args.release(args.entry.key, args.entry.charge)
  args.entry.reject(migrationOwnsFailure ? migrationCompletionError(args.error) : args.error)
  if (!migrationOwnsFailure) {
    args.closeGeneration(args.entry.key.providerGeneration)
  }
  args.cleanup(args.id, args.usage)
}

function migrationCompletionError(cause: Error): Error {
  return Object.assign(new Error(cause.message), {
    code: 'ssh_model_migration_completion_failed',
    cause
  })
}

function cancelQueuedEntry(
  entry: AdmissionEntry,
  error: Error,
  release: (key: SshPtyModelAdmissionKey, charge: AdmissionCharge) => void
): void {
  if (entry.state === 'settled') {
    return
  }
  entry.state = 'settled'
  release(entry.key, entry.charge)
  entry.reject(error)
}
