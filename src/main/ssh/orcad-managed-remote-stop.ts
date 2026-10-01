/**
 * Stopping one remote orcad instance through its instance-bound request, never a signal.
 *
 * The client names the instance from two host records that must agree: the slot's readiness
 * payload (runtime ID, PID, capability) and the data root's instance lock (PID, start time,
 * nonce). The slot's own `orcad.js` then writes the request and proves exit on the host.
 */
import { shellEscape } from './ssh-connection-utils'
import { assertPosixOrcadHost } from './orcad-remote-host-support'
import { selectOrcadSlotRuntimeCommand } from './orcad-remote-runtime'
import { parseOrcadReadinessOutput, readOrcadReadinessCommand } from './orcad-remote-launch'
import { execOrcadRemote } from './orcad-remote-runtime-control'
import { readBoundedOrcadRemoteRecord } from './orcad-remote-record-file'
import { orcadSlotDir, type OrcadSlotOptions } from './orcad-recovery-slot'
import { joinRemotePath } from './ssh-remote-platform'
import { ORCAD_LOCK_FILE_NAME, parseOrcadInstanceLockRecord } from '../orcad/orcad-instance-lock'
import {
  ORCAD_CANCEL_MANAGED_STOP_FLAG,
  ORCAD_COMPLETE_MANAGED_STOP_FLAG,
  ORCAD_STOP_REQUESTS_CAPABILITY,
  OrcadManagedStopCancellationSchema,
  OrcadManagedStopCompletionSchema,
  type OrcadManagedStopCancellation,
  type OrcadManagedStopCompletion,
  type OrcadManagedStopContext,
  type OrcadManagedStopRequest
} from '../../shared/orcad-stop-request'

const LOCK_RECORD_MAX_BYTES = 64 * 1024

export type OrcadManagedStopTarget =
  | { state: 'ready'; context: OrcadManagedStopContext }
  | { state: 'refused'; verdict: 'unverifiable'; code: string; reason: string }

function refused(code: string, reason: string): OrcadManagedStopTarget {
  return { state: 'refused', verdict: 'unverifiable', code, reason }
}

/** Names the running instance of `version`, or says why the host could not prove which it is. */
export async function readRemoteOrcadManagedStopTarget(
  options: OrcadSlotOptions,
  version: string
): Promise<OrcadManagedStopTarget> {
  assertPosixOrcadHost(options.host)
  const slotDir = orcadSlotDir(options, version)
  const readiness = parseOrcadReadinessOutput(
    await execOrcadRemote(options, readOrcadReadinessCommand(options.host, slotDir))
  )
  if (readiness.state !== 'ready' || !readiness.readiness.health) {
    return refused(
      'orcad_managed_stop_readiness_unverifiable',
      `orcad ${version} has no readable readiness record, so the running instance is unknown.`
    )
  }
  const { health, runtimeId } = readiness.readiness
  if (health.stopRequests !== ORCAD_STOP_REQUESTS_CAPABILITY) {
    return refused(
      'orcad_managed_stop_unsupported',
      `orcad ${version} predates managed stop requests; it can only be stopped by signal.`
    )
  }
  const lockPath = joinRemotePath(options.host, options.userDataDir, ORCAD_LOCK_FILE_NAME)
  const lockRead = await readBoundedOrcadRemoteRecord(options, lockPath, LOCK_RECORD_MAX_BYTES)
  const lock = lockRead.state === 'present' ? parseOrcadInstanceLockRecord(lockRead.raw) : null
  if (!lock || lock.pid !== health.pid || !runtimeId) {
    return refused(
      'orcad_managed_stop_instance_unverifiable',
      `The instance lock does not name the orcad ${version} that published readiness.`
    )
  }
  return {
    state: 'ready',
    context: {
      version,
      runtimeId,
      instance: { pid: lock.pid, startedAtMs: lock.startedAtMs, nonce: lock.nonce, lockPath }
    }
  }
}

export async function completeRemoteOrcadManagedStop(
  options: OrcadSlotOptions,
  request: OrcadManagedStopRequest
): Promise<OrcadManagedStopCompletion> {
  return OrcadManagedStopCompletionSchema.parse(
    await runSlotCommand(options, request, ORCAD_COMPLETE_MANAGED_STOP_FLAG)
  )
}

export async function cancelRemoteOrcadManagedStop(
  options: OrcadSlotOptions,
  request: OrcadManagedStopRequest
): Promise<OrcadManagedStopCancellation> {
  return OrcadManagedStopCancellationSchema.parse(
    await runSlotCommand(options, request, ORCAD_CANCEL_MANAGED_STOP_FLAG)
  )
}

/** Runs the slot's own build, which owns the request format it is asked to write. */
async function runSlotCommand(
  options: OrcadSlotOptions,
  request: OrcadManagedStopRequest,
  flag: string
): Promise<unknown> {
  const slotDir = orcadSlotDir(options, request.version)
  const entry = joinRemotePath(options.host, slotDir, 'orcad.js')
  const output = await execOrcadRemote(
    options,
    `${selectOrcadSlotRuntimeCommand(options.host, slotDir, options.nodePath)} && ` +
      `"$orcad_runtime" ${shellEscape(entry)} ${flag} ${shellEscape(JSON.stringify(request))}`
  )
  const line = output
    .trim()
    .split('\n')
    .findLast((candidate) => candidate.trim().startsWith('{'))
  if (!line) {
    throw new Error('orcad managed stop command returned no verifiable answer')
  }
  const parsed: unknown = JSON.parse(line)
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('orcad managed stop command returned no verifiable answer')
  }
  // The answer must be about this exact request, not another transaction's.
  if (!('transactionId' in parsed) || parsed.transactionId !== request.transactionId) {
    throw new Error('orcad managed stop command answered another transaction')
  }
  return parsed
}
