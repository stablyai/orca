import type { RpcClient } from '../transport/rpc-client'
import type { RpcResponse } from '../transport/types'
import { isRpcDeliveryUnknown } from '../transport/rpc-delivery-ambiguity'
import { waitForRpcClientReconnected } from '../transport/rpc-client-reconnect-wait'
import { isLogicalClientCutoverError } from '../transport/stable-logical-rpc-client'
import {
  getWorktreeCreateReplayWindowMs,
  type WorktreeCreateIdempotencySupport
} from './worktree-create-idempotency-policy'

// Why: a request in flight when the mobile transport migrates (relay/direct hand-off on shoddy
// cellular, relay lease rotation) rejects with a cutover error even though the host may have
// completed it. The caller's replay identity makes a resend safe, so re-issue on the fresh session a
// bounded number of times instead of surfacing "RPC interrupted by connection migration".
const CUTOVER_MAX_RETRIES = 5

// Why: a plain socket close (cellular flap, relay drop, the phone backgrounding) also rejects the
// in-flight frame as delivery-unknown with no generation bump. The host may well have acted, so
// replay on the same identity instead of reporting a failure.
const AMBIGUOUS_MAX_RETRIES = 2

// Bounded so a spinner doesn't sit for the whole window; the deadline still caps it.
export const AMBIGUOUS_RECONNECT_WAIT_MS = 20_000

/**
 * What makes resending the SAME request safe after an ambiguous delivery.
 *
 * `durable`: the host keeps a ledger row for the caller's operation id and answers a replay from it
 * (or refuses an unknown outcome), so a resend is safe at any time. `window`: the host only caches a
 * result in memory for a bounded time, so a resend is safe only while that record is guaranteed.
 */
export type AmbiguousDeliveryReplay =
  | { kind: 'durable' }
  | { kind: 'window'; support: WorktreeCreateIdempotencySupport }

/**
 * Sends, re-issuing the identical request whenever it went delivery-ambiguous. `send` must resend
 * the same identity every call: a new one would be a new operation and defeat the replay.
 *
 * A definite answer (a success or a refusal) is returned untouched; `replayed` says whether it came
 * from a resend, because a refusal on a replacement connection says nothing about what the first
 * attempt did. With no replay policy the first transport error is rethrown.
 */
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
      // `send` must hand back the transport promise itself, so a delivery-unknown rejection reaches
      // the catch below as the object the transport marked — the WeakSet cannot see through a wrapper.
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
        // Why: LogicalClientCutoverError is raised only after migrateTo installs an
        // authenticated replacement, so retry immediately instead of adding UI lag.
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

// Latest instant the host's dedupe record is still guaranteed to exist, from the earliest
// point the request could have resolved. lastInboundAt stamps a frame that really arrived,
// so it stays honest across a suspension in a way a timer budget cannot; the send is the
// fallback, and a sound floor either way, because the host cannot resolve a request it has
// not yet received.
function resolveReplayDeadline(
  client: RpcClient,
  firstSentAt: number,
  support: WorktreeCreateIdempotencySupport
): number {
  const lastInboundAt = client.getLastInboundAt?.() ?? null
  const anchor = lastInboundAt !== null && lastInboundAt > firstSentAt ? lastInboundAt : firstSentAt
  return anchor + getWorktreeCreateReplayWindowMs(support)
}
