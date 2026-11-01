// Request shutdown without signaling; only kernel identity, owner change or PID absence proves exit.
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
  // Wall-clock drift alone cannot prove PID reuse.
  const identity = compareOrcadProcessIdentity(instance.pid, recorded, options)
  return identity === 'differs' ? 'exited' : identity === 'unproven' ? 'unverifiable' : 'live'
}

/** Recover incarnation data from the lock for older clients that omit it. */
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
  return { ...instance, ...recordedOrcadProcessIncarnation(record), identity: record.identity }
}

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
    // A live process that relinquished its lock is no longer ours to address.
    return 'unverifiable'
  }
  if (readOrcadManagedStopDecision(request) === 'canceled') {
    return 'live'
  }
  const requestPath = orcadManagedStopRequestPath(request.instance)
  if (!existingRequestMatches(requestPath, request)) {
    return 'unverifiable'
  }
  if (!writeDurableSecureJsonFile(requestPath, request)) {
    throw new Error('orcad_managed_stop_request_permissions_unconfirmed')
  }
  // A cancel between the first check and write had no request file to remove.
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
