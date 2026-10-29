import type { RpcClient } from '../transport/rpc-client'
import type { RpcResponse } from '../transport/types'
import { isRpcDeliveryUnknown } from '../transport/rpc-delivery-ambiguity'
import { waitForRpcClientReconnected } from '../transport/rpc-client-reconnect-wait'
import { isLogicalClientCutoverError } from '../transport/stable-logical-rpc-client'
import {
  getWorktreeCreateReplayWindowMs,
  type WorktreeCreateIdempotencySupport
} from './worktree-create-idempotency-policy'

// Cutover can lose a reply after the host acted; replay only with the caller’s unchanged dedupe identity.
const CUTOVER_MAX_RETRIES = 5

// Socket closes can also lose delivery without a generation bump; replay the same identity.
const AMBIGUOUS_MAX_RETRIES = 2

export const AMBIGUOUS_RECONNECT_WAIT_MS = 20_000

// Durable ledgers safely answer or refuse any replay; in-memory dedupe is safe only within its guaranteed window.
export type AmbiguousDeliveryReplay =
  | { kind: 'durable' }
  | { kind: 'window'; support: WorktreeCreateIdempotencySupport }

// Resend the identical identity after ambiguous delivery; return definite answers untouched.
// A refusal after reconnection does not prove what the first attempt did; expose replayed to the caller.
export async function sendReplayingAmbiguousDelivery(
  client: RpcClient,
  send: () => Promise<RpcResponse>,
  replay: AmbiguousDeliveryReplay | null
): Promise<{ response: RpcResponse; replayed: boolean }> {
  let migrationRetry = 0
  let ambiguousRetry = 0
  const firstSentAt = Date.now()
  let replayDeadlineAt: number | null = null
  for (;;) {
    try {
      // Keep the transport promise’s original rejection object; delivery-unknown is tracked by WeakSet identity.
      const response = await send()
      return { response, replayed: migrationRetry > 0 || ambiguousRetry > 0 }
    } catch (error) {
      if (!replay) {
        throw error
      }
      if (isLogicalClientCutoverError(error)) {
        if (migrationRetry >= CUTOVER_MAX_RETRIES) {
          throw error
        }
        migrationRetry += 1
        // Cutover errors arrive only after an authenticated replacement is installed, so retry immediately.
        continue
      }
      if (!isRpcDeliveryUnknown(error) || ambiguousRetry >= AMBIGUOUS_MAX_RETRIES) {
        throw error
      }
      // A legacy cache may expire before a request timeout; durable receipts refuse unsafe replay.
      if (replay.kind === 'window' && client.getState() === 'connected') {
        throw error
      }
      // Keep the legacy deadline fixed; the host itself refuses expired durable operation IDs.
      replayDeadlineAt ??=
        replay.kind === 'durable'
          ? Infinity
          : resolveReplayDeadline(client, firstSentAt, replay.support)
      const remainingWindowMs = replayDeadlineAt - Date.now()
      if (remainingWindowMs <= 0) {
        throw error
      }
      ambiguousRetry += 1
      // Disconnected transports must reconnect before resend; bound the wait even for durable IDs.
      if (
        !(await waitForRpcClientReconnected(
          client,
          Math.min(AMBIGUOUS_RECONNECT_WAIT_MS, remainingWindowMs)
        ))
      ) {
        throw error
      }
    }
  }
}

// Measure legacy dedupe expiry from a received frame, falling back to send time; wall-clock evidence survives suspension.
function resolveReplayDeadline(
  client: RpcClient,
  firstSentAt: number,
  support: WorktreeCreateIdempotencySupport
): number {
  const lastInboundAt = client.getLastInboundAt?.() ?? null
  const anchor = lastInboundAt !== null && lastInboundAt > firstSentAt ? lastInboundAt : firstSentAt
  return anchor + getWorktreeCreateReplayWindowMs(support)
}
