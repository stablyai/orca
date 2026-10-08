/** Validating an instance-bound stop request before the running orcad acts on it. */
import { createHash } from 'node:crypto'
import { lstatSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { readNodeFileSyncWithinLimit } from '../../shared/node-bounded-file-reader'
import {
  ORCAD_MANAGED_STOP_REQUEST_MAX_BYTES,
  ORCAD_MANAGED_STOP_REQUEST_PREFIX,
  OrcadManagedStopRequestSchema,
  type OrcadManagedStopContext,
  type OrcadManagedStopInstance,
  type OrcadManagedStopRequest
} from '../../shared/orcad-stop-request'
import { readOrcadInstanceLockRecord } from './orcad-instance-lock'

/** Keyed by the lock nonce, so a request for a previous instance is never this one's. */
export function orcadManagedStopRequestPath(instance: OrcadManagedStopInstance): string {
  const digest = createHash('sha256').update(instance.nonce).digest('hex')
  return join(dirname(instance.lockPath), `${ORCAD_MANAGED_STOP_REQUEST_PREFIX}.${digest}`)
}

export function readOrcadManagedStopRequest(path: string): OrcadManagedStopRequest {
  if (!lstatSync(path).isFile()) {
    throw new Error('orcad_managed_stop_request_not_regular_file')
  }
  const { buffer } = readNodeFileSyncWithinLimit(path, ORCAD_MANAGED_STOP_REQUEST_MAX_BYTES)
  return OrcadManagedStopRequestSchema.parse(JSON.parse(buffer.toString('utf8')))
}

export function sameOrcadManagedStopInstance(
  left: OrcadManagedStopInstance,
  right: Pick<OrcadManagedStopInstance, 'pid' | 'startedAtMs' | 'nonce'>
): boolean {
  return (
    left.pid === right.pid && left.startedAtMs === right.startedAtMs && left.nonce === right.nonce
  )
}

/** Whether the instance lock still names exactly this instance. */
export function orcadInstanceLockNames(instance: OrcadManagedStopInstance): boolean {
  if (!lstatSync(instance.lockPath).isFile()) {
    return false
  }
  const record = readOrcadInstanceLockRecord(instance.lockPath)
  return record !== null && sameOrcadManagedStopInstance(instance, record)
}

/** Throws unless the request names this running instance and its lock is still ours. */
export function validateOrcadManagedStopRequest(
  context: OrcadManagedStopContext,
  requestPath: string
): OrcadManagedStopRequest {
  const request = readOrcadManagedStopRequest(requestPath)
  if (
    request.version !== context.version ||
    request.runtimeId !== context.runtimeId ||
    // Resolved: a Windows client names the lock with `/`, orcad's own path.join with `\`.
    resolve(request.instance.lockPath) !== resolve(context.instance.lockPath) ||
    !sameOrcadManagedStopInstance(request.instance, context.instance)
  ) {
    throw new Error('orcad_managed_stop_request_identity_mismatch')
  }
  if (!orcadInstanceLockNames(context.instance)) {
    throw new Error('orcad_managed_stop_instance_lock_changed')
  }
  return request
}
