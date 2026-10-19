/**
 * Bounds on the relay-era CLI calls one host can hold open on this desktop, and the one replay
 * that may skip part of the scope check.
 * COMPAT(legacy-relay-bridge): revisit 2027-01-15.
 */
import { ORCHESTRATION_ASK_MAX_TIMEOUT_MS } from '../../../shared/orchestration-ask-timeout'
import { isDurableMutation } from '../../../shared/orchestration-rpc-contract'
import type { OrcaRuntimeService } from '../../runtime/orca-runtime'
import { ALL_RPC_METHODS } from '../../runtime/rpc/methods'
import {
  hashCanonical,
  readPromptBasePayloadHash,
  replayStableCallerParams
} from '../../runtime/rpc/orchestration-mutation-receipt'
import { getCompiledSchema } from '../../zod-schema-compilation'
import type { LegacyRelayCliCall } from './legacy-relay-cli-caller'

/** Enough for a coordinator and its workers' waits; past it a host is flooding this desktop. */
const MAX_CALLS_PER_HOST = 16
/** How soon turning the per-host switch off reaches a call that is already waiting. */
const SWITCH_POLL_MS = 1_000

const inFlightByHost = new Map<string, number>()

/** A host must not park a desktop waiter for longer than the longest ask may wait. */
export function cappedWait(timeoutMs: number | undefined): number | undefined {
  return timeoutMs === undefined
    ? undefined
    : Math.min(Math.max(0, timeoutMs), ORCHESTRATION_ASK_MAX_TIMEOUT_MS)
}

/** The inbox handler passes `limit` straight to SQL, where a negative one means "every row". */
const MAX_INBOX_ROWS = 100

export function cappedInboxLimit(limit: number | undefined): number | undefined {
  return limit === undefined ? undefined : Math.min(Math.max(1, Math.floor(limit)), MAX_INBOX_ROWS)
}

export const LEGACY_RELAY_CLI_BUSY =
  'This host already has too many older-terminal orca commands waiting on this desktop. ' +
  'Let some finish, then try again.'

/**
 * Runs one call under the host's concurrency cap, aborted when the relay connection closes or the
 * per-host switch turns off (read on a timer, so every path that edits the setting is covered).
 */
export async function runLegacyRelayCliCall<T>(
  targetId: string,
  allowed: () => boolean,
  relaySignal: AbortSignal,
  run: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  const inFlight = inFlightByHost.get(targetId) ?? 0
  if (inFlight >= MAX_CALLS_PER_HOST) {
    throw new Error(LEGACY_RELAY_CLI_BUSY)
  }
  inFlightByHost.set(targetId, inFlight + 1)
  const controller = new AbortController()
  const abort = (): void => controller.abort()
  relaySignal.addEventListener('abort', abort, { once: true })
  const revoked = setInterval(() => {
    if (!allowed()) {
      abort()
    }
  }, SWITCH_POLL_MS)
  try {
    if (relaySignal.aborted) {
      abort()
    }
    return await run(controller.signal)
  } finally {
    clearInterval(revoked)
    relaySignal.removeEventListener('abort', abort)
    const remaining = (inFlightByHost.get(targetId) ?? 1) - 1
    if (remaining > 0) {
      inFlightByHost.set(targetId, remaining)
    } else {
      inFlightByHost.delete(targetId)
    }
  }
}

/**
 * True only for a retry the executor will answer from its receipt: same method, same caller
 * fingerprint, and the exact payload hash it recorded. Call while the caller's identity is
 * registered, since the hash reads the caller's pane through the runtime.
 */
export function isExactLegacyRelayCliReplay(
  runtime: OrcaRuntimeService,
  fingerprint: string,
  requestId: string,
  call: LegacyRelayCliCall
): boolean {
  const receipt = runtime.getOrchestrationDb().getMutationReceipt(fingerprint, requestId)
  const method = ALL_RPC_METHODS.find((entry) => entry.name === call.method)
  if (
    receipt?.state !== 'completed' ||
    receipt.method !== call.method ||
    !method?.params ||
    !isDurableMutation(call.method, call.params)
  ) {
    return false
  }
  const parsed = getCompiledSchema(method.params).safeParse(call.params)
  if (!parsed.success) {
    return false
  }
  const payloadHash = hashCanonical({
    method: call.method,
    params: replayStableCallerParams(runtime, parsed.data)
  })
  return readPromptBasePayloadHash(receipt.payload_hash) === payloadHash
}
