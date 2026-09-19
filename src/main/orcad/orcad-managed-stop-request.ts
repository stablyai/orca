import { lstatSync } from 'node:fs'
import { readNodeFileSyncWithinLimit } from '../../shared/node-bounded-file-reader'
import { sameOrcadManagedStopAuthority } from '../../shared/orcad-managed-stop-authority'
import { OrcadManagedStopIdentitySchema } from '../../shared/orcad-managed-decommission'
import { OrcadManagedStopInstanceSchema } from '../../shared/orcad-managed-stop-instance'
import {
  ORCAD_MANAGED_STOP_REQUEST_MAX_BYTES,
  OrcadManagedStopRequestSchema
} from '../../shared/orcad-managed-stop-request'
import { validateOrcadDecommissionCompletion } from './orcad-decommission-acceptance'
import { readOrcadInstanceLockRecord } from './orcad-instance-lock'
import type { z } from 'zod'

const RunningManagedStopIdentitySchema = OrcadManagedStopIdentitySchema.extend({
  instance: OrcadManagedStopInstanceSchema
})
export type OrcadManagedStopRequestContext = z.infer<typeof RunningManagedStopIdentitySchema>

export function createOrcadManagedStopRequestValidator(
  context: OrcadManagedStopRequestContext,
  home?: string
): (requestPath: string) => void {
  const running = RunningManagedStopIdentitySchema.parse(context)
  return (requestPath) => {
    if (!lstatSync(requestPath).isFile()) {
      throw new Error('orcad_managed_stop_request_not_regular_file')
    }
    const { buffer, stats } = readNodeFileSyncWithinLimit(
      requestPath,
      ORCAD_MANAGED_STOP_REQUEST_MAX_BYTES
    )
    if (!stats.isFile()) {
      throw new Error('orcad_managed_stop_request_not_regular_file')
    }
    const request = OrcadManagedStopRequestSchema.parse(JSON.parse(buffer.toString('utf8')))
    if (
      request.version !== running.version ||
      !sameOrcadManagedStopAuthority(request.authority, {
        ...running.identity,
        transactionId: request.authority.transactionId
      }) ||
      request.instance.pid !== running.instance.pid ||
      request.instance.startedAtMs !== running.instance.startedAtMs ||
      request.instance.nonce !== running.instance.nonce ||
      request.instance.lockPath !== running.instance.lockPath
    ) {
      throw new Error('orcad_managed_stop_request_identity_mismatch')
    }
    if (
      validateOrcadDecommissionCompletion(
        request.authority,
        running.version,
        home,
        running.instance
      ) === 'process-exited'
    ) {
      throw new Error('orcad_managed_stop_already_completed')
    }
    if (!lstatSync(running.instance.lockPath).isFile()) {
      throw new Error('orcad_managed_stop_instance_lock_changed')
    }
    const lock = readOrcadInstanceLockRecord(running.instance.lockPath)
    if (
      !lock ||
      lock.pid !== running.instance.pid ||
      lock.startedAtMs !== running.instance.startedAtMs ||
      lock.nonce !== running.instance.nonce
    ) {
      throw new Error('orcad_managed_stop_instance_lock_changed')
    }
  }
}
