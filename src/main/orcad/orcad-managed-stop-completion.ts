/**
 * Asking one orcad instance to stop and proving that it did.
 *
 * Runs as a short-lived command on the execution host. It never signals: it writes the
 * instance-bound request the running orcad watches for, then observes until the instance is
 * gone. `exited` needs proof — no process with that PID, or a PID whose start time shows it now
 * belongs to another process. Anything the host cannot answer is `unverifiable`, never exit.
 */
import { setTimeout as delay } from 'node:timers/promises'
import { writeDurableSecureJsonFile } from '../../shared/secure-file'
import {
  OrcadManagedStopRequestSchema,
  type OrcadManagedStopInstance,
  type OrcadManagedStopRequest,
  type OrcadManagedStopVerdict
} from '../../shared/orcad-stop-request'
import {
  START_TIME_TOLERANCE_MS,
  startTimesWithinTolerance
} from '../daemon/daemon-process-start-time'
import { readOrcadProcessStartedAtMs } from './orcad-process-start-time'
import { hasErrorCode, inspectProcessSignal } from '../daemon/daemon-process-inspection'
import { persistOrcadCompletedStopReceipt } from './orcad-completed-stop-receipt'
import { readOrcadManagedStopDecision } from './orcad-managed-stop-decision'
import { withdrawOrcadManagedStopRequest } from './orcad-managed-stop-cancellation'
import {
  orcadInstanceLockNames,
  orcadManagedStopRequestPath,
  readOrcadManagedStopRequest
} from './orcad-managed-stop-request'
import {
  ORCAD_STOP_COMPLETION_POLL_ATTEMPTS,
  ORCAD_STOP_COMPLETION_POLL_MS
} from './orcad-stop-deadlines'

export type OrcadProcessProbe = (pid: number) => 'alive' | 'missing' | 'unverifiable'

export type OrcadManagedStopCompletionOptions = {
  probeProcess?: OrcadProcessProbe
  startedAtMs?: (pid: number) => number | null
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
  options: OrcadManagedStopCompletionOptions
): OrcadManagedStopVerdict {
  const probe = (options.probeProcess ?? defaultProbe)(instance.pid)
  if (probe !== 'alive') {
    return probe === 'missing' ? 'exited' : 'unverifiable'
  }
  const actual = (options.startedAtMs ?? readOrcadProcessStartedAtMs)(instance.pid)
  // A reused PID is proof of exit only when both start times are known and disagree; on Windows
  // without the addon both stay null, so a live PID is never read as exited.
  if (
    actual !== null &&
    instance.startedAtMs !== null &&
    !startTimesWithinTolerance(actual, instance.startedAtMs, START_TIME_TOLERANCE_MS)
  ) {
    return 'exited'
  }
  return 'live'
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
  let verdict = observeInstance(request.instance, options)
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
    verdict = observeInstance(request.instance, options)
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
    return JSON.stringify(readOrcadManagedStopRequest(path)) === JSON.stringify(request)
  } catch (error) {
    return hasErrorCode(error, 'ENOENT')
  }
}
