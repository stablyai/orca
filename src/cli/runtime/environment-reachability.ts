import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { withFileTransactionLock } from '../../main/file-transaction-lock'
import { readNodeFileSyncWithinLimit } from '../../shared/node-bounded-file-reader'
import { writeSecureJsonFileWithinLimit } from '../../shared/bounded-secure-json-file'
import { hardenExistingSecureFile } from '../../shared/secure-file'
import { runtimeEnvironmentSidecarBinding } from '../../shared/runtime-environment-sidecar'
import {
  getPreferredPairedRuntimeConnection,
  type KnownRuntimeEnvironment
} from '../../shared/runtime-environments'
import { sendRemoteRuntimeRequest } from '../../shared/remote-runtime-client'
import { evaluateRuntimeCompat } from '../../shared/protocol-compat'
import {
  MIN_COMPATIBLE_RUNTIME_SERVER_VERSION,
  RUNTIME_PROTOCOL_VERSION
} from '../../shared/protocol-version'
import { RuntimeClientError, RuntimeRpcFailureError } from './types'
import { resolveEnvironment } from './environments'

const MAX_HISTORY_BYTES = 8 * 1024
const StatusProtocolSchema = z.object({
  runtimeId: z.string().min(1),
  runtimeProtocolVersion: z.number().int().nonnegative().optional(),
  protocolVersion: z.number().int().nonnegative().optional(),
  minCompatibleRuntimeClientVersion: z.number().int().nonnegative().optional(),
  minCompatibleMobileVersion: z.number().int().nonnegative().optional()
})
const TimestampSchema = z.number().finite().min(0).max(8_640_000_000_000_000)
const ReachabilitySchema = z.object({
  status: z.enum(['online', 'unreachable', 'blocked', 'unknown']),
  checkedAt: TimestampSchema.nullable(),
  lastSeenAt: TimestampSchema.nullable(),
  failureCode: z.string().max(80).nullable()
})
const HistorySchema = z.object({
  version: z.literal(1),
  environmentId: z.string(),
  observation: ReachabilitySchema
})

export type EnvironmentReachability = z.infer<typeof ReachabilitySchema> & { historySaved?: false }

function unknown(failureCode: string | null = null): EnvironmentReachability {
  return { status: 'unknown', checkedAt: null, lastSeenAt: null, failureCode }
}

function connectionKey(environment: KnownRuntimeEnvironment): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        id: environment.id,
        ...runtimeEnvironmentSidecarBinding(environment),
        connection: getPreferredPairedRuntimeConnection(environment)
      })
    )
    .digest('hex')
}

function historyPath(userDataPath: string, environment: KnownRuntimeEnvironment): string {
  return join(userDataPath, 'environment-reachability-v1', `${connectionKey(environment)}.json`)
}

/** Last explicit probe of this saved connection; reading never contacts a host. */
export function readEnvironmentReachability(
  userDataPath: string,
  environment: KnownRuntimeEnvironment
): EnvironmentReachability {
  const path = historyPath(userDataPath, environment)
  if (!existsSync(path)) {
    return unknown()
  }
  try {
    hardenExistingSecureFile(path)
    const record = HistorySchema.parse(
      JSON.parse(
        readNodeFileSyncWithinLimit(path, MAX_HISTORY_BYTES, {
          regularFileOnly: true
        }).buffer.toString('utf8')
      )
    )
    return record.environmentId === environment.id
      ? record.observation
      : unknown('cache_unavailable')
  } catch {
    return unknown('cache_unavailable')
  }
}

function probeFailure(error: unknown): Pick<EnvironmentReachability, 'status' | 'failureCode'> {
  const code =
    error instanceof Error && 'code' in error && typeof error.code === 'string'
      ? error.code
      : 'unknown_error'
  if (
    ['unauthorized', 'forbidden', 'incompatible_runtime', 'protocol_version_mismatch'].includes(
      code
    )
  ) {
    return { status: 'blocked', failureCode: code }
  }
  if (
    ['remote_runtime_unavailable', 'runtime_timeout', 'runtime_unavailable', 'timeout'].includes(
      code
    )
  ) {
    return { status: 'unreachable', failureCode: code }
  }
  return {
    status: 'unknown',
    failureCode: code === 'invalid_runtime_response' ? code : 'unknown_error'
  }
}

function stillCurrent(userDataPath: string, environment: KnownRuntimeEnvironment): boolean {
  try {
    return (
      connectionKey(resolveEnvironment(userDataPath, environment.id)) === connectionKey(environment)
    )
  } catch {
    return false
  }
}

/** A bounded authenticated status read; it never connects SSH, provisions, or starts a runtime. */
export async function probeEnvironmentReachability(
  userDataPath: string,
  environment: KnownRuntimeEnvironment,
  timeoutMs = 5_000
): Promise<EnvironmentReachability> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 30_000) {
    throw new RuntimeClientError(
      'invalid_argument',
      '--timeout-ms must be an integer from 1 to 30000.'
    )
  }
  let verdict: Pick<EnvironmentReachability, 'status' | 'failureCode'>
  const controller = new AbortController()
  const deadline = setTimeout(
    () =>
      controller.abort(new RuntimeClientError('runtime_timeout', 'Reachability probe timed out.')),
    timeoutMs
  )
  try {
    // Why: probing a captured pairing must not update a newer pairing's runtime identity.
    const response = await sendRemoteRuntimeRequest<unknown>(
      getPreferredPairedRuntimeConnection(environment),
      'status.get',
      undefined,
      timeoutMs,
      undefined,
      controller.signal
    )
    if (!response.ok) {
      throw new RuntimeRpcFailureError(response)
    }
    const parsed = StatusProtocolSchema.safeParse(response.result)
    if (!parsed.success) {
      throw new RuntimeClientError('invalid_runtime_response', 'Invalid runtime status response.')
    }
    const status = parsed.data
    const compatibility = evaluateRuntimeCompat({
      clientProtocolVersion: RUNTIME_PROTOCOL_VERSION,
      minCompatibleServerProtocolVersion: MIN_COMPATIBLE_RUNTIME_SERVER_VERSION,
      serverProtocolVersion: status.runtimeProtocolVersion ?? status.protocolVersion,
      serverMinCompatibleClientProtocolVersion:
        status.minCompatibleRuntimeClientVersion ?? status.minCompatibleMobileVersion
    })
    verdict =
      compatibility.kind === 'ok'
        ? { status: 'online', failureCode: null }
        : { status: 'blocked', failureCode: 'incompatible_runtime' }
  } catch (error) {
    verdict = probeFailure(error)
  } finally {
    clearTimeout(deadline)
  }
  const checkedAt = Date.now()
  if (!stillCurrent(userDataPath, environment)) {
    return { ...unknown('environment_changed'), checkedAt }
  }
  const prior = readEnvironmentReachability(userDataPath, environment)
  let observation: EnvironmentReachability = {
    ...verdict,
    checkedAt,
    lastSeenAt: verdict.status === 'online' ? checkedAt : prior.lastSeenAt
  }
  try {
    return await withFileTransactionLock(
      historyPath(userDataPath, environment),
      async () => {
        if (!stillCurrent(userDataPath, environment)) {
          return { ...unknown('environment_changed'), checkedAt }
        }
        const previous = readEnvironmentReachability(userDataPath, environment)
        observation = {
          ...observation,
          lastSeenAt: Math.max(observation.lastSeenAt ?? 0, previous.lastSeenAt ?? 0) || null
        }
        // Why: preserve the newest verdict and every successful sighting, including delayed writers.
        const latest =
          previous.checkedAt !== null && previous.checkedAt > checkedAt
            ? { ...previous, lastSeenAt: observation.lastSeenAt }
            : observation
        writeSecureJsonFileWithinLimit(
          historyPath(userDataPath, environment),
          {
            version: 1,
            environmentId: environment.id,
            observation: latest
          },
          MAX_HISTORY_BYTES
        )
        return observation
      },
      { retries: 0 }
    )
  } catch {
    return { ...observation, historySaved: false }
  }
}
