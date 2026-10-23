/**
 * Asking one orcad instance to stop and proving that it did.
 *
 * Runs as a short-lived command on the execution host. It never signals: it writes the
 * instance-bound request the running orcad watches for, then observes until the instance is
 * gone. `exited` needs proof — no process with that PID, or a PID whose kernel identity or owner
 * uid shows it now belongs to another process. A wall-clock disagreement, or anything the host
 * cannot answer, is `unverifiable`, never exit.
 */
import { setTimeout as delay } from 'node:timers/promises'
import { writeDurableSecureJsonFile } from '../../shared/secure-file'
import {
  OrcadManagedStopRequestSchema,
  orcadManagedStopRequestKey,
  type OrcadManagedStopInstance,
  type OrcadManagedStopRequest,
  type OrcadManagedStopVerdict
} from '../../shared/orcad-stop-request'
import {
  compareOrcadProcessIdentity,
  recordedOrcadProcessIncarnation,
  type OrcadProcessIdentityReaders,
  type OrcadRecordedIdentity
} from './orcad-process-start-time'
import { hasErrorCode, inspectProcessSignal } from '../daemon/daemon-process-inspection'
import { persistOrcadCompletedStopReceipt } from './orcad-completed-stop-receipt'
import { readOrcadManagedStopDecision } from './orcad-managed-stop-decision'
import { withdrawOrcadManagedStopRequest } from './orcad-managed-stop-cancellation'
import {
  orcadInstanceLockNames,
  orcadManagedStopRequestPath,
  readOrcadInstanceLockNaming,
  readOrcadManagedStopRequest
} from './orcad-managed-stop-request'
import {
  ORCAD_STOP_COMPLETION_POLL_ATTEMPTS,
  ORCAD_STOP_COMPLETION_POLL_MS
} from './orcad-stop-deadlines'

type OrcadProcessProbe = (pid: number) => 'alive' | 'missing' | 'unverifiable'

export type OrcadManagedStopCompletionOptions = OrcadProcessIdentityReaders & {
  probeProcess?: OrcadProcessProbe
  sleep?: () => Promise<void>
  attempts?: number
  now?: () => Date
}

function defaultProbe(pid: number): ReturnType<OrcadProcessProbe> {
  const signal = inspectProcessSignal(pid)
  // EPERM proves some process holds the PID; it cannot prove ours exited.
  return signal === 'occupied' ? 'alive' : signal === 'missing' ? 'missing' : 'unverifiable'
}

function observeInstance(
  instance: OrcadManagedStopInstance,
  recorded: OrcadRecordedIdentity,
  options: OrcadManagedStopCompletionOptions
): OrcadManagedStopVerdict {
  const probe = (options.probeProcess ?? defaultProbe)(instance.pid)
  if (probe !== 'alive') {
    return probe === 'missing' ? 'exited' : 'unverifiable'
  }
  // Only a kernel identity, stored creation time or owner uid proves reuse; unknown stays live.
  const identity = compareOrcadProcessIdentity(instance.pid, recorded, options)
  return identity === 'differs' ? 'exited' : identity === 'unproven' ? 'unverifiable' : 'live'
}

/** An older client's request lacks the incarnation; the lock still naming the instance has it. */
function recordedIdentity(instance: OrcadManagedStopInstance): OrcadRecordedIdentity {
  if (recordedOrcadProcessIncarnation(instance)) {
    return instance
  }
  let record: OrcadRecordedIdentity | null = null
  try {
    record = readOrcadInstanceLockNaming(instance)
  } catch {
    return instance
  }
  if (!record) {
    return instance
  }
  // The lock's identity lets a reused PID be proven by its owner uid.
  return { ...instance, ...recordedOrcadProcessIncarnation(record), identity: record.identity }
}

/** Writes the request only while the lock still names this instance, then waits for exit. */
export async function completeOrcadManagedStop(
  input: OrcadManagedStopRequest,
  options: OrcadManagedStopCompletionOptions = {}
): Promise<OrcadManagedStopVerdict> {
  const request = OrcadManagedStopRequestSchema.parse(input)
  const attempts = options.attempts ?? ORCAD_STOP_COMPLETION_POLL_ATTEMPTS
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 240) {
    throw new Error('orcad_managed_stop_invalid_attempts')
  }
  const completed = (): 'exited' => {
    persistOrcadCompletedStopReceipt(request, (options.now ?? (() => new Date()))())
    return 'exited'
  }
  const recorded = recordedIdentity(request.instance)
  let verdict = observeInstance(request.instance, recorded, options)
  if (verdict !== 'live') {
    return verdict === 'exited' ? completed() : verdict
  }
  if (!lockStillNamesInstance(request.instance)) {
    // The process lives but no longer owns the lock it published: it is not ours to address.
    return 'unverifiable'
  }
  if (readOrcadManagedStopDecision(request) === 'canceled') {
    // A cancelled transaction is never reissued; its orcad keeps running.
    return 'live'
  }
  const requestPath = orcadManagedStopRequestPath(request.instance)
  if (!existingRequestMatches(requestPath, request)) {
    return 'unverifiable'
  }
  if (!writeDurableSecureJsonFile(requestPath, request)) {
    throw new Error('orcad_managed_stop_request_permissions_unconfirmed')
  }
  // A cancel that won between the check above and this write found no file to remove.
  if (readOrcadManagedStopDecision(request) === 'canceled') {
    withdrawOrcadManagedStopRequest(request)
    return 'live'
  }
  for (let attempt = 0; attempt < attempts; attempt++) {
    await (options.sleep ?? (() => delay(ORCAD_STOP_COMPLETION_POLL_MS)))()
    verdict = observeInstance(request.instance, recorded, options)
    if (verdict !== 'live') {
      return verdict === 'exited' ? completed() : verdict
    }
  }
  return 'live'
}

function lockStillNamesInstance(instance: OrcadManagedStopInstance): boolean {
  try {
    return orcadInstanceLockNames(instance)
  } catch {
    return false
  }
}

/** A request already present must be this one; another transaction's request is not ours. */
function existingRequestMatches(path: string, request: OrcadManagedStopRequest): boolean {
  try {
    return (
      orcadManagedStopRequestKey(readOrcadManagedStopRequest(path)) ===
      orcadManagedStopRequestKey(request)
    )
  } catch (error) {
    return hasErrorCode(error, 'ENOENT')
  }
}
