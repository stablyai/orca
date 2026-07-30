import type {
  SshPtyModelAdmissionKey,
  SshPtyModelAdmissionReceipt
} from './ssh-pty-model-admission-contract'
import type { SshPtyModelAdmissionLimits } from './ssh-pty-model-admission-limits'

export type AdmissionCharge = { sourceUnits: number; bytes: number }

export type AdmissionEntry = {
  key: SshPtyModelAdmissionKey
  charge: AdmissionCharge
  run: () => { sequence: number; completion: Promise<void> }
  resolve: (receipt: SshPtyModelAdmissionReceipt) => void
  reject: (error: Error) => void
  state: 'queued' | 'running' | 'pressure' | 'settled'
}

export type PtyUsage = AdmissionCharge & {
  queued: AdmissionEntry[]
  running: AdmissionEntry | null
}

export function admissionError(code: string): Error {
  return Object.assign(new Error(code), { code })
}

export function retainedBytes(data: string): number {
  return Math.max(Buffer.byteLength(data, 'utf8'), 2 * data.length) + 128
}

export function admissionKeyId(key: SshPtyModelAdmissionKey): string {
  return `${key.providerGeneration}\0${key.ptyId}`
}

export function canReserveAdmission(args: {
  key: SshPtyModelAdmissionKey
  charge: AdmissionCharge
  limits: SshPtyModelAdmissionLimits
  usageByPty: ReadonlyMap<string, PtyUsage>
  closingGenerations: ReadonlySet<number>
  globalSourceUnits: number
  globalBytes: number
}): boolean {
  if (args.closingGenerations.has(args.key.providerGeneration)) {
    return false
  }
  const usage = args.usageByPty.get(admissionKeyId(args.key))
  return (
    (usage?.sourceUnits ?? 0) + args.charge.sourceUnits <= args.limits.perPtyHighSourceUnits &&
    (usage?.bytes ?? 0) + args.charge.bytes <= args.limits.perPtyHighBytes &&
    args.globalSourceUnits + args.charge.sourceUnits <= args.limits.globalHighSourceUnits &&
    args.globalBytes + args.charge.bytes <= args.limits.globalHighBytes
  )
}

export function pressureHasAdmissionKey(
  entries: readonly AdmissionEntry[],
  key: SshPtyModelAdmissionKey
): boolean {
  const id = admissionKeyId(key)
  return entries.some((entry) => admissionKeyId(entry.key) === id)
}

export function takePressureEntriesForGeneration(
  entries: AdmissionEntry[],
  providerGeneration: number
): AdmissionEntry[] {
  const removed: AdmissionEntry[] = []
  for (let index = entries.length - 1; index >= 0; index--) {
    if (entries[index]!.key.providerGeneration === providerGeneration) {
      removed.unshift(entries.splice(index, 1)[0]!)
    }
  }
  return removed
}

export function cancelAdmissionGeneration(args: {
  pressure: AdmissionEntry[]
  usageByPty: Map<string, PtyUsage>
  idleWaiters: Map<string, Set<() => void>>
  providerGeneration: number
  error: Error
  release: (key: SshPtyModelAdmissionKey, charge: AdmissionCharge) => void
}): number {
  let pressureBytes = 0
  for (const entry of takePressureEntriesForGeneration(args.pressure, args.providerGeneration)) {
    pressureBytes += entry.charge.bytes
    entry.state = 'settled'
    entry.reject(args.error)
  }
  for (const [id, usage] of args.usageByPty) {
    const canceled = usage.queued.filter(
      (entry) => entry.key.providerGeneration === args.providerGeneration
    )
    usage.queued = usage.queued.filter(
      (entry) => entry.key.providerGeneration !== args.providerGeneration
    )
    if (usage.running?.key.providerGeneration === args.providerGeneration) {
      canceled.push(usage.running)
      usage.running = null
    }
    for (const entry of canceled) {
      if (entry.state === 'settled') {
        continue
      }
      entry.state = 'settled'
      args.release(entry.key, entry.charge)
      entry.reject(args.error)
    }
    if (!usage.running && usage.queued.length === 0 && usage.sourceUnits === 0) {
      args.usageByPty.delete(id)
    }
    resolveAdmissionIdleWaiters(args.usageByPty, args.pressure, args.idleWaiters, id)
  }
  return pressureBytes
}

export function takePausedGeneration(
  paused: Map<string, SshPtyModelAdmissionKey>,
  providerGeneration: number
): SshPtyModelAdmissionKey[] {
  const removed: SshPtyModelAdmissionKey[] = []
  for (const [id, key] of paused) {
    if (key.providerGeneration === providerGeneration) {
      paused.delete(id)
      removed.push(key)
    }
  }
  return removed
}

export function resolveAdmissionIdleWaiters(
  usageByPty: ReadonlyMap<string, PtyUsage>,
  pressure: readonly AdmissionEntry[],
  waitersById: Map<string, Set<() => void>>,
  id: string
): void {
  const usage = usageByPty.get(id)
  const stillPressured = pressure.some((entry) => admissionKeyId(entry.key) === id)
  if (usage?.running || (usage?.queued.length ?? 0) > 0 || stillPressured) {
    return
  }
  const waiters = waitersById.get(id)
  if (!waiters) {
    return
  }
  waitersById.delete(id)
  for (const resolve of waiters) {
    resolve()
  }
}
