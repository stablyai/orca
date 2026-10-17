import type { RpcClient } from './rpc-client'

export const FORCE_RECONNECT_VERIFY_TIMEOUT_MS = 15_000

// Why: a reopened socket only proves the desktop accepted a connection. #10385 is
// exactly the case where that holds while the control channel is dead, so Force
// Reconnect must not report success until the desktop has actually answered.
//
// What is being asked is whether the control channel is alive, not whether the
// request succeeded, so any answer passes — an `ok:false` error included. The
// desktop received it, processed it and replied, which settles the question; a
// transient application error is not a reason to tear down a working channel.
// Only silence fails.
//
// `status.get` is chosen because it is on the mobile method allowlist, so no
// version gap can masquerade as a failure. A desktop-only method such as
// `worktree.list` would draw `ok:false` from an older allowlist purely for not
// being implemented, making a healthy channel indistinguishable from a dead one.
export async function forceReconnectAnswered(
  client: Pick<RpcClient, 'sendRequest'>,
  timeoutMs: number = FORCE_RECONNECT_VERIFY_TIMEOUT_MS
): Promise<boolean> {
  try {
    await client.sendRequest('status.get', undefined, {
      timeoutMs,
      budgetSpansConnect: true
    })
    return true
  } catch {
    return false
  }
}
