import { lstatSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { readNodeFileSyncWithinLimit } from '../../shared/node-bounded-file-reader'
import { writeDurableSecureJsonFile } from '../../shared/secure-file'
import {
  orcadManagedStopRequestFilename,
  ORCAD_MANAGED_STOP_REQUEST_MAX_BYTES,
  OrcadManagedStopRequestSchema,
  type OrcadManagedStopRequest
} from '../../shared/orcad-managed-stop-request'
import { validateOrcadDecommissionCompletion } from './orcad-decommission-acceptance'
import { readOrcadInstanceLockRecord } from './orcad-instance-lock'
import { persistOrcadCompletedStopReceipt } from './orcad-completed-stop-receipt'

export type OrcadManagedStopCompletionVerdict = 'live' | 'unverifiable' | 'exited'

function errorCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'code' in error ? error.code : null
}

function probeProcess(pid: number): OrcadManagedStopCompletionVerdict {
  try {
    process.kill(pid, 0)
    return 'live'
  } catch (error) {
    return errorCode(error) === 'ESRCH' ? 'exited' : 'unverifiable'
  }
}

export async function completeOrcadManagedStop(
  input: OrcadManagedStopRequest,
  home: string,
  options: {
    probeProcess?: (pid: number) => OrcadManagedStopCompletionVerdict
    sleep?: () => Promise<void>
    attempts?: number
  } = {}
): Promise<OrcadManagedStopCompletionVerdict> {
  const request = OrcadManagedStopRequestSchema.parse(input)
  const probe = options.probeProcess ?? probeProcess
  const attempts = options.attempts ?? 80
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 240) {
    throw new Error('orcad_managed_stop_invalid_attempts')
  }
  const observe = (): OrcadManagedStopCompletionVerdict | 'tearing-down' => {
    const phase = validateOrcadDecommissionCompletion(
      request.authority,
      request.version,
      home,
      request.instance
    )
    try {
      if (!lstatSync(request.instance.lockPath).isFile()) {
        return 'unverifiable'
      }
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') {
        return 'unverifiable'
      }
      // Lock release alone precedes process exit; a reused PID keeps the fence.
      const processVerdict = probe(request.instance.pid)
      return processVerdict === 'live' ? 'tearing-down' : processVerdict
    }
    const lock = readOrcadInstanceLockRecord(request.instance.lockPath)
    if (
      !lock ||
      lock.nonce !== request.instance.nonce ||
      lock.pid !== request.instance.pid ||
      lock.startedAtMs !== request.instance.startedAtMs
    ) {
      return 'unverifiable'
    }
    return phase !== 'process-exited' && probe(request.instance.pid) === 'live'
      ? 'live'
      : 'unverifiable'
  }
  let verdict = observe()
  const completed = (): 'exited' => {
    persistOrcadCompletedStopReceipt(request, home)
    return 'exited'
  }
  if (verdict === 'exited') {
    return completed()
  }
  if (verdict !== 'live') {
    return verdict === 'tearing-down' ? 'unverifiable' : verdict
  }
  const requestPath = join(
    dirname(request.instance.lockPath),
    orcadManagedStopRequestFilename(request.instance)
  )
  try {
    if (!lstatSync(requestPath).isFile()) {
      return 'unverifiable'
    }
    const existing = OrcadManagedStopRequestSchema.parse(
      JSON.parse(
        readNodeFileSyncWithinLimit(
          requestPath,
          ORCAD_MANAGED_STOP_REQUEST_MAX_BYTES
        ).buffer.toString('utf8')
      )
    )
    if (JSON.stringify(existing) !== JSON.stringify(request)) {
      return 'unverifiable'
    }
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') {
      return 'unverifiable'
    }
  }
  if (!writeDurableSecureJsonFile(requestPath, request)) {
    throw new Error('orcad_managed_stop_request_permissions_unconfirmed')
  }
  for (let attempt = 0; attempt < attempts; attempt++) {
    await (options.sleep ?? (() => delay(250)))()
    verdict = observe()
    if (verdict === 'exited' || verdict === 'unverifiable') {
      return verdict === 'exited' ? completed() : verdict
    }
    // Missing lock while the process is still tearing down is retryable, never completion.
  }
  return verdict === 'tearing-down' ? 'unverifiable' : verdict
}
