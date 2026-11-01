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
import { readOrcadInstanceLockRecord, type OrcadLockRecord } from './orcad-instance-lock'

/** Nonce-scoped paths prevent requests from addressing a previous instance. */
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

function sameOrcadManagedStopInstance(
  left: OrcadManagedStopInstance,
  right: Pick<OrcadManagedStopInstance, 'pid' | 'startedAtMs' | 'nonce'>
): boolean {
  return (
    left.pid === right.pid && left.startedAtMs === right.startedAtMs && left.nonce === right.nonce
  )
}

export function orcadInstanceLockNames(instance: OrcadManagedStopInstance): boolean {
  return readOrcadInstanceLockNaming(instance) !== null
}

export function readOrcadInstanceLockNaming(
  instance: OrcadManagedStopInstance
): OrcadLockRecord | null {
  if (!lstatSync(instance.lockPath).isFile()) {
    return null
  }
  const record = readOrcadInstanceLockRecord(instance.lockPath)
  return record !== null && sameOrcadManagedStopInstance(instance, record) ? record : null
}

export function validateOrcadManagedStopRequest(
  context: OrcadManagedStopContext,
  requestPath: string
): OrcadManagedStopRequest {
  const request = readOrcadManagedStopRequest(requestPath)
  if (
    request.version !== context.version ||
    request.runtimeId !== context.runtimeId ||
    // Windows clients and servers may use different separators for the same lock.
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
