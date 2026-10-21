import { createHash } from 'node:crypto'
import { toRuntimeExecutionHostId, toSshExecutionHostId } from '../../shared/execution-host'
import { MachineProviderError, type ProviderMachine } from '../../shared/machine-provider-protocol'
import {
  isStalePendingCreate,
  type MachineProviderFailure,
  type MachineProviderInventory,
  type MachineProviderKey,
  type MachineRecord
} from '../../shared/machine-inventory'

export function findRecord(
  inventory: MachineProviderInventory,
  machineId: string
): MachineRecord | undefined {
  return inventory.machines.find((record) => record.id === machineId)
}

export function requireRecord(
  inventory: MachineProviderInventory,
  machineId: string
): MachineRecord {
  const record = findRecord(inventory, machineId)
  if (!record) {
    throw new MachineProviderError('not-found', `No machine ${machineId}.`)
  }
  return record
}

/** Undefined patch fields drop out when the store is serialized. */
export function patchRecord(
  inventory: MachineProviderInventory,
  machineId: string,
  patch: Partial<MachineRecord>
): MachineRecord {
  const existing = requireRecord(inventory, machineId)
  const next: MachineRecord = { ...existing, ...patch }
  inventory.machines = inventory.machines.map((entry) => (entry === existing ? next : entry))
  return next
}

export function applyMachine(
  inventory: MachineProviderInventory,
  providerKey: MachineProviderKey,
  machine: ProviderMachine,
  now: number
): MachineRecord {
  const existing = findRecord(inventory, machine.id)
  // Providers may stop reporting the create key once running; keep it for reconcile.
  const creatingOperationId = machine.creatingOperationId ?? existing?.creatingOperationId
  const { access, ...rest } = machine
  const record: MachineRecord = {
    ...rest,
    // Pairing codes are credentials: the row keeps none, and the hash is recorded only on pairing.
    ...(access?.kind === 'orca-server'
      ? { access: { ...access, pairingCode: '' } }
      : access
        ? { access }
        : {}),
    providerKey,
    lastSeenAt: now,
    ...(creatingOperationId ? { creatingOperationId } : {}),
    ...(existing?.sshTargetId ? { sshTargetId: existing.sshTargetId } : {}),
    ...(existing?.runtimeEnvironmentId
      ? { runtimeEnvironmentId: existing.runtimeEnvironmentId }
      : {}),
    ...(existing?.managedEnvironmentId
      ? { managedEnvironmentId: existing.managedEnvironmentId }
      : {}),
    ...(existing?.pairingCodeSha256 ? { pairingCodeSha256: existing.pairingCodeSha256 } : {})
  }
  inventory.machines = existing
    ? inventory.machines.map((entry) => (entry === existing ? record : entry))
    : [...inventory.machines, record]
  return record
}

export function applyInventory(
  inventory: MachineProviderInventory,
  providerKey: MachineProviderKey,
  machines: readonly ProviderMachine[],
  now: number,
  /** Machines a lifecycle result newer than this list already settled; the list leaves them be. */
  settledSince: (machineId: string) => boolean = () => false
): void {
  const listed = new Set(machines.map((machine) => machine.id))
  for (const machine of machines) {
    if (!settledSince(machine.id)) {
      applyMachine(inventory, providerKey, machine, now)
    }
  }
  // Absent from a successful list: gone. Rows nothing points at are simply dropped.
  inventory.machines = inventory.machines.flatMap((record) =>
    listed.has(record.id) || settledSince(record.id)
      ? [record]
      : record.sshTargetId || record.runtimeEnvironmentId || record.managedEnvironmentId
        ? [{ ...record, state: 'gone' as const, access: undefined }]
        : []
  )
  const created = new Set(inventory.machines.map((machine) => machine.creatingOperationId))
  // Past the reconcile window, a successful list without the tag proves nothing was created.
  inventory.pendingCreates = inventory.pendingCreates.filter(
    (pending) => !created.has(pending.operationId) && !isStalePendingCreate(pending, now)
  )
  inventory.listedAt = now
  inventory.lastFailure = undefined
}

/** Loss of contact: the machine may well still exist, so it is unreachable, never gone. */
export function markUnreachable(
  inventory: MachineProviderInventory,
  machineId: string,
  error: unknown
): void {
  const record = findRecord(inventory, machineId)
  if (record && record.state !== 'gone') {
    patchRecord(inventory, machineId, { state: 'unreachable', lastError: messageOf(error) })
  }
}

export function markGone(inventory: MachineProviderInventory, machineId: string): MachineRecord {
  return patchRecord(inventory, machineId, { state: 'gone', access: undefined })
}

export function dropPendingCreate(inventory: MachineProviderInventory, operationId: string): void {
  inventory.pendingCreates = inventory.pendingCreates.filter(
    (pending) => pending.operationId !== operationId
  )
}

export function pairingCodeSha256(pairingCode: string): string {
  return createHash('sha256').update(pairingCode).digest('hex')
}

export function failureOf(error: unknown, at: number): MachineProviderFailure {
  return {
    code: error instanceof MachineProviderError ? error.code : 'unavailable',
    message: messageOf(error),
    at
  }
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Gone rows kept only as Gone links for worktrees; beyond this the oldest are dropped. */
export const MAX_GONE_MACHINE_RECORDS = 50

/**
 * Drops gone rows no repo or workspace on this host still runs on, then caps the rest. A row's
 * links are its SSH target and its runtime or managed server environments, as execution host ids.
 */
export function pruneGoneRecords(
  inventory: MachineProviderInventory,
  isHostReferenced: (hostId: string) => boolean
): void {
  const linked = (record: MachineRecord): boolean =>
    [
      record.sshTargetId ? toSshExecutionHostId(record.sshTargetId) : null,
      record.runtimeEnvironmentId ? toRuntimeExecutionHostId(record.runtimeEnvironmentId) : null,
      record.managedEnvironmentId ? toRuntimeExecutionHostId(record.managedEnvironmentId) : null
    ].some((hostId) => hostId !== null && isHostReferenced(hostId))
  const kept = inventory.machines.filter((record) => record.state !== 'gone' || linked(record))
  const newestGoneFirst = kept
    .filter((record) => record.state === 'gone')
    .sort((left, right) => right.lastSeenAt - left.lastSeenAt)
  const dropped = new Set(newestGoneFirst.slice(MAX_GONE_MACHINE_RECORDS))
  inventory.machines = kept.filter((record) => !dropped.has(record))
}

const FAILURE_BACKOFF_MS = [30_000, 120_000, 600_000]

/** A failing provider backs off; otherwise the cache answers while it is younger than `maxAgeMs`. */
export function isInventoryFresh(
  inventory: MachineProviderInventory,
  now: number,
  consecutiveFailures: number,
  maxAgeMs: number | undefined
): boolean {
  if (consecutiveFailures > 0 && inventory.lastFailure) {
    const step = Math.min(consecutiveFailures, FAILURE_BACKOFF_MS.length) - 1
    return now - inventory.lastFailure.at < (FAILURE_BACKOFF_MS[step] ?? 0)
  }
  return (
    maxAgeMs !== undefined &&
    inventory.listedAt !== undefined &&
    now - inventory.listedAt < maxAgeMs
  )
}
