# Design: Resilient Remote Orca terminal recovery

**Date:** 2026-07-11

**Issue:** [#8180](https://github.com/stablyai/orca/issues/8180)

**Scope:** Desktop client, Remote Orca control/stream transports, and runtime WebSocket heartbeat

**Status:** Approved; implementation is being delivered as a three-PR stack

## Problem

A recoverable client sleep or network-path interruption can leave a Remote Orca terminal permanently offline even though the remote runtime, PTY, and agent remain alive.

The failure is a race between two independent WebSocket lanes:

1. The dedicated `terminal.multiplex` socket detects silence and reports an error followed by close.
2. The terminal pane reacts to close by making one `session.tabs.list` request on shared control so it can re-resolve the host-owned terminal handle.
3. Shared control can still be half-open or reconnecting from the same interruption. If that single list request times out, it resets shared control.
4. The failed request is not replayed and the pane has no retry trigger, so the remote task continues without a usable client terminal.

The current liveness monitor can also misclassify the first timer tick after a long event-loop or system-sleep gap. It checks accumulated silence before giving a new post-resume probe a response window.

This design fixes the ownership and recovery model. It does not merely increase timeout constants.

## Goals

- Treat sleep, event-loop pauses, half-open sockets, and network-path changes as recoverable transport events.
- Preserve the logical terminal while physical sockets reconnect.
- Re-resolve host-owned terminal handles from a fresh authoritative session snapshot.
- Coalesce recovery work across panes that share an environment and worktree.
- Retry transient recovery indefinitely, with bounded resource use, while at least one logical pane still exists.
- Prevent old callbacks or ambiguous queued input from reaching a newly rebound handle.
- Keep terminal and shared-control sockets separate.
- Preserve compatibility with older Remote Orca runtimes.

## Non-goals

- Merging dedicated binary streams into shared control.
- Recreating or killing the remote PTY during transport recovery.
- Adding input sequence numbers, delivery acknowledgements, or exactly-once input semantics.
- Automatically replaying arbitrary short RPC requests after a reconnect.
- Adding a new terminal UI component. Existing remote-host status can show reconnecting; the pane keeps its last rendered buffer and must not show a fatal transport banner.
- Changing pairing, encryption, or the runtime RPC wire protocol.

## Current failure chain

| Stage | Current behavior | Failure |
| --- | --- | --- |
| Socket liveness | `remote-runtime-socket-liveness.ts` compares wall-clock silence before sending the next ping. | A delayed first tick after sleep can declare the socket dead using only pre-pause evidence. |
| Dedicated stream | `remote-runtime-client.ts` sends established failures through `onError` and then `onClose`. | A recoverable physical failure is presented as both fatal error and close. |
| Multiplexer | `remote-runtime-terminal-multiplexer.ts` forwards the error to every stream before its close recovery callback. | Each pane can show a fatal error before recovery begins. |
| Handle refresh | `remote-runtime-pty-transport.ts` performs one `session.tabs.list` and one resubscribe. | A shared-control race stops recovery permanently after the first failure. |
| Shared control | A short request timeout tears down the entire control socket; subscription reconnect has a finite retry budget. | Unrelated inbound traffic cannot prove the socket alive, and a long outage exhausts logical subscriptions. |
| Input | Debounced input is read against the current handle when it finally flushes. | Bytes queued before recovery can cross into a replacement handle unless recovery clears and fences them. |

## Decision summary

| Area | Decision | Why | Tradeoff |
| --- | --- | --- | --- |
| Liveness | Use pause-aware, probe-based liveness on client and server. Only an unanswered probe may kill a socket. | Raw elapsed silence after sleep is not proof of a dead connection. | Genuine death is detected after one full post-pause probe window instead of immediately on resume. |
| Transport topology | Keep shared control and `terminal.multiplex` as separate sockets. | Binary terminal traffic must not head-of-line block control RPCs or subscriptions. | Recovery needs explicit coordination between the two lanes. |
| Recovery ownership | Add one recovery coordinator per runtime environment, with worktree-scoped authoritative snapshot requests. | Panes currently retry independently and can stampede control RPCs. | Adds a small lifecycle state machine and registry. |
| Snapshot source | During host-mirror recovery, wait on one temporary, coalesced `session.tabs.subscribe` snapshot instead of a one-shot `session.tabs.list`. | Shared-control subscriptions survive reconnect and replay an authoritative snapshot; a short RPC does not. | A temporary subscription exists during recovery, then closes after the generation settles. |
| Retry policy | Exponential base delays from 250 ms to a 30 s cap, with actual jitter kept inside that cap while logical owners remain. System resume requests an immediate attempt. | A remote task may run for hours; a finite retry budget creates permanent client-side failure. | Persistent outages keep a low-frequency retry timer until panes close or the error is fatal. |
| Error policy | Transport/liveness/timeout failures are recoverable. Authentication, invalid protocol, removed environment, and confirmed terminal-gone results are terminal. | Users should not see duplicate fatal banners for a reconnectable socket loss. | Error classification must preserve structured codes across the subscription boundary. |
| Binding safety | Fence callbacks and asynchronous sends by recovery generation; commit a replacement binding atomically. | Handle equality alone is insufficient when the same handle string can reappear after reconnect. | Adds generation checks to existing handle checks. |
| Input safety | Clear pending batches when recovery starts and reject new input until the new binding is ready. Never replay delivery-ambiguous bytes. | Sending old bytes to a new handle is worse than rejecting keystrokes during a short reconnect. | Keystrokes entered during recovery are not buffered; callers receive `false` and can retry. |
| Short RPC timeout | Reject the timed-out request, but tear down shared control only if no valid inbound frame arrived after that request was sent. | A stuck method is not proof that the whole multiplexed control socket is dead. | Requires an inbound-activity generation counter. |

## Architecture

### 1. Pause-aware probe liveness

`startRemoteRuntimeSocketLiveness` will track:

- `lastInboundActivityAt`
- `lastTickAt`
- `probeSentAt: number | null`

The behavior follows the existing `WebRuntimeClient` heartbeat invariant:

1. If a tick arrives much later than its configured cadence, treat the gap as suspended execution, clear any old probe debt, and re-baseline time.
2. If there is no outstanding probe and the socket has been idle long enough, send a ping and record `probeSentAt`.
3. Close only when that sent probe remains unanswered for the full probe grace window while ticks continue normally.
4. Any valid inbound frame, ping, or pong clears the outstanding probe and records activity.

The first tick after a one-hour jump therefore cannot kill the socket. It re-baselines; a later normal tick sends a fresh probe; only that probe's full unanswered window can call `onDead`.

The runtime server heartbeat in `src/main/runtime/rpc/ws-transport.ts` gets the same pause rule. If the runtime's own heartbeat loop was suspended, the first resumed tick marks existing sockets as unproven and sends a fresh ping instead of terminating all of them. A runtime that stayed awake may still reap a sleeping client's dead socket; the client recovery path must reconnect cleanly.

No protocol changes are required because Node `ws` already answers RFC 6455 pings automatically.

### 2. Structured dedicated-stream close

The established dedicated subscription boundary already preserves `{ code, message }`. The multiplexer will distinguish:

- startup failure before the subscription becomes ready: reject `subscribeTerminal()`;
- remote terminal stream `error` event: deliver the terminal-specific error;
- established physical socket loss with a recoverable code: deliver one `onTransportClose` event carrying the reason, without first calling pane `onError`;
- fatal authentication/protocol failure: deliver one fatal error and close.

This removes the current recoverable `onError` then `onClose` double delivery. It does not hide actual server-side terminal errors.

### 3. Environment recovery coordinator

Add `remote-runtime-terminal-recovery-coordinator.ts` in the renderer runtime layer. The module owns a registry keyed by runtime environment id. Each entry owns:

- a monotonic recovery generation;
- the current state: `idle`, `waiting-control`, `rebinding`, `backoff`, or `disposed`;
- a cancellable retry timer;
- registered pane recovery operations;
- coalesced authoritative snapshot work keyed by worktree selector;
- attempt count and local diagnostics.

The coordinator does not own PTYs and never issues `terminal.create` or `terminal.close`.

Each pane recovery registration provides:

- its worktree and host surface identity, if it is a host mirror;
- its last known handle;
- a generation-fenced callback that resolves the next handle from a snapshot;
- a callback that subscribes the dedicated stream;
- a terminal-gone callback;
- an abort signal tied to detach/destroy or a newer recovery generation.

Multiple panes in the same environment/worktree await the same session snapshot. Snapshot entries are reference-counted: aborting one pane removes only that waiter, while aborting the final waiter closes the temporary subscription, cancels its timer, and removes the entry. Different worktrees in the same environment use different snapshot entries. Multiple dedicated resubscriptions still share the existing environment multiplexer and its single physical socket.

The coordinator takes injected clock, scheduler, and snapshot-subscription seams. Production supplies real timers and `window.api.runtimeEnvironments`; tests drive each transition directly instead of relying on fake timers to auto-run every missed interval after a clock jump.

### 4. Authoritative handle recovery

For a host-mirrored terminal:

1. Start or join the worktree's temporary `session.tabs.subscribe` recovery subscription.
2. If the initial subscription cannot start because shared control is unavailable, retry its creation with capped backoff.
3. Once established, let shared control retain and replay it across reconnects.
4. Accept the first valid `snapshot` or `updated` result for the active recovery generation as authoritative.
5. Resolve each pane's host tab/leaf to a ready terminal handle.
6. Close the temporary recovery subscription after all current waiters have consumed the snapshot.

If the snapshot confirms that the surface is gone, retire the local mirror without recreating or closing any remote PTY. If the surface exists but is not ready yet, remain in recovery and wait for a later subscription update.

For a direct remote terminal whose handle is not host-published, skip the session snapshot and retry the known handle on a fresh dedicated stream. A server `terminal_handle_stale`, `terminal_exited`, `terminal_gone`, or `no_connected_pty` result retires it.

### 5. Shared-control durability

Shared-control logical subscriptions will no longer fail only because a fixed reconnect delay list was exhausted.

- Recoverable transport errors use base delays of `250, 500, 1000, 2000, 4000, 8000, 15000, 30000` ms. Existing 20% jitter is preserved, and the saturated window shifts below the hard 30-second cap.
- Closing the last logical subscription cancels the timer and allows the connection to become idle.
- `unauthorized`, `invalid_argument`, and `invalid_runtime_response` stop retrying and notify subscribers once.
- Successful readiness keeps the existing stable-window attempt reset, so short flaps do not create a tight loop.

The recovery error matrix is explicit:

| Error | Recovery action |
| --- | --- |
| `remote_runtime_unavailable`, `runtime_timeout`, abnormal network close | Retry with capped backoff. |
| `unauthorized`, `invalid_argument`, `invalid_runtime_response` | Stop, cancel the generation, and surface one fatal error. |
| Known terminal-gone result (`terminal_handle_stale`, `terminal_exited`, `terminal_gone`, `no_connected_pty`) | Retire that logical terminal without closing or recreating a PTY. |
| Other `runtime_error` result | Do not classify it as transport loss; stop that operation and surface it once so invalid parameters cannot loop forever. |
| Explicit environment removal, disconnect, pane detach, or pane destroy | Cancel timers/subscriptions and dispose without allowing late callbacks to reopen the connection. |

Short RPCs remain at-most-once from the client's perspective. Each pending request records the shared-control inbound-activity generation at actual send time. On timeout:

- always reject that request;
- if no newer valid inbound frame has arrived, close the suspect socket so reconnect/replay can run;
- if newer inbound traffic exists, keep the socket because the failure is method-specific, not connection-wide.

Recovery does not depend on replaying a failed `session.tabs.list`; it uses the temporary logical subscription described above.

### 6. Atomic terminal rebind and input fence

Each remote PTY transport keeps an integer `bindingGeneration` in addition to its handle checks.

When recovery begins:

1. Increment the generation.
2. Mark the binding `recovering` while preserving the rendered terminal buffer.
3. Clear pending text and viewport sends associated with the old stream.
4. Reject `sendInput`, `sendInputImmediate`, and acknowledged input that has not yet begun a current-generation send.
5. Abort older snapshot/subscription work.

The replacement handle and stream are staged separately. They become the active binding only after the dedicated multiplexer confirms subscription for the same generation. The initial terminal snapshot remains the authoritative display resync. Only then does input resume.

Every data, snapshot, end, error, fit, driver, input continuation, and close callback captures both the binding generation and handle. A stale callback is ignored even if its handle string matches a later binding.

Acknowledged multi-chunk input rechecks generation and handle between chunks. Bytes already handed to the old physical socket are never replayed because their delivery is ambiguous.

Resize remains locally meaningful while input is paused. A resize during recovery updates only `desiredViewport`; it cannot use `terminal.updateViewport` against the old handle. The latest desired size is included in the generation's new dedicated subscribe request.

### 7. Resume acceleration

The renderer already receives `window.api.ui.onSystemResumed`. The terminal wake-recovery hook will also notify the Remote Orca recovery coordinator.

Resume does not create a new recovery when all streams are healthy. It only cancels a pending backoff delay and requests an immediate attempt for entries already in `waiting-control` or `backoff`. Normal capped backoff resumes after a failed immediate attempt.

## Recovery sequence

```text
dedicated stream closes
  -> multiplexer emits one recoverable transport-close event
  -> pane starts binding generation N and pauses input
  -> environment coordinator coalesces panes
       -> direct handle: reuse known handle
       -> host mirror: await coalesced session-tabs subscription snapshot
  -> coordinator asks shared multiplexer to subscribe all generation-N handles
  -> dedicated stream confirms subscribe and sends authoritative terminal snapshot
  -> pane atomically activates generation N and resumes input
```

At any asynchronous boundary, detach, destroy, a newer close, or a fatal error aborts generation N. Its later callbacks cannot mutate current pane state.

## Expected file changes

| Path | Change |
| --- | --- |
| `src/shared/remote-runtime-socket-liveness.ts` | Replace raw-silence death with pause-aware sent-probe tracking. |
| `src/shared/remote-runtime-socket-liveness.test.ts` | New deterministic timer-jump, probe, activity, and dead-link tests. |
| `src/main/runtime/rpc/ws-transport.ts` | Make server heartbeat pause-aware. |
| `src/main/runtime/rpc/ws-transport.test.ts` | Prove first resumed server tick re-probes instead of terminating healthy sockets. |
| `src/shared/remote-runtime-client.ts` | Preserve structured established-stream failure semantics. |
| `src/shared/remote-runtime-client.test.ts` | Cover one close signal for established recoverable failure. |
| `src/shared/remote-runtime-shared-control-{connection,reconnect,requests,state,types}.ts` | Add saturated retry, fatal classification, and inbound-activity generation. |
| `src/shared/remote-runtime-shared-control-connection.test.ts` | Cover long outage recovery, fatal stop, request-only timeout, and silent-socket teardown. |
| `src/renderer/src/runtime/remote-runtime-terminal-recovery-coordinator.ts` | New environment/worktree recovery state machine and snapshot coalescing. |
| `src/renderer/src/runtime/remote-runtime-terminal-recovery-coordinator.test.ts` | New state, retry, coalescing, cancellation, and resume tests. |
| `src/renderer/src/runtime/remote-runtime-terminal-multiplexer.ts` | Deliver recoverable physical close without a preceding fatal pane error; preserve codes/generations. |
| `src/renderer/src/components/terminal-pane/remote-runtime-pty-transport.ts` | Register recovery, stage atomic bindings, and fence input/callbacks. |
| `src/renderer/src/components/terminal-pane/remote-runtime-pty-transport.test.ts` | Extend two-lane recovery, multi-pane, stale callback, and input safety tests. |
| `src/renderer/src/components/terminal-pane/use-terminal-window-wake-recovery.ts` | Trigger immediate retry for already-recovering Remote Orca entries on OS resume. |

The implementation may split an already-long module into concrete domain-named files. It must not add a max-lines suppression or a generic `helpers`/`utils` module.

## Test plan

### Deterministic unit and integration tests

1. **Client liveness pause**
   - Advance the injected clock by one hour before the next tick.
   - Assert no `onDead` on that tick.
   - Assert a fresh ping receives a full grace window.

2. **Client liveness real death**
   - Run normal-cadence ticks, send a probe, provide no activity, and advance beyond grace.
   - Assert exactly one `onDead`.

3. **Runtime heartbeat pause**
   - Delay the server heartbeat by more than two cadences.
   - Assert it re-arms/pings existing sockets and terminates only after the next unanswered normal-cadence window.

4. **Shared-control request timeout**
   - With no inbound activity after send, assert the request rejects and the socket reconnects.
   - With an unrelated valid inbound frame after send, assert only the request rejects and the socket remains ready.

5. **Shared-control long outage**
   - Exhaust every backoff tier and verify retries remain capped at 30 seconds while a logical subscription exists.
   - Restore connectivity and verify one replayed authoritative response.
   - Verify fatal authentication/protocol errors stop once.

6. **Two-lane terminal recovery regression**
   - Establish a host-mirrored terminal.
   - Blackhole both dedicated and shared-control sockets beyond their deadlines while leaving the fake remote PTY alive.
   - Make the first recovery subscription start fail or time out.
   - Restore control, emit one replayed session snapshot, then restore the dedicated stream.
   - Assert the same remote PTY is rebound without manual refresh, create, or close.

7. **Multi-pane coalescing**
   - Recover two or more panes in one environment/worktree.
   - Assert one temporary session-tabs subscription and one physical dedicated connection attempt.
   - Recover another pane in a different worktree of the same environment and assert it uses a separate snapshot entry without opening a second physical dedicated connection.

8. **Generation and input safety**
   - Queue debounced input, start recovery, and rebind to a different handle.
   - Assert the queued bytes never reach either the replacement stream or RPC fallback.
   - Resolve old snapshot/subscribe/end/error callbacks after the new binding is active and assert they have no effect.
   - Assert input returns `false` during recovery and works after the new subscription is confirmed.
   - Resize during recovery and assert no old-handle RPC is sent; the next subscribe carries only the latest viewport.

9. **Lifecycle cleanup**
   - Destroy all waiting panes during backoff.
   - Assert timers, temporary subscriptions, multiplexer streams, and registry entries are released.
   - Explicitly disconnect or remove the environment, then resolve old promises and assert they cannot reopen or rebind anything.

10. **Cross-lane event ordering**
    - Parameterize `stream error -> control timeout -> resume`, `control timeout -> stream close -> resume`, and `resume -> late old response -> new response`.
    - Assert each outage creates one active generation, no concurrent retry after resume, and no stale completion wins.

### Real macOS to Windows verifier

Before PR submission, verify against a physical Windows Remote Orca host with a macOS desktop client. Run one round with the same fix commit on both machines, then one backward-compatibility round with the patched Mac client against the current stable Windows runtime:

1. Open three panes: two in one worktree and one in a second worktree. Start long-running PowerShell counters with distinct nonces and record runtime/terminal PIDs without publishing private host data.
2. Suspend the Mac for 60–90 seconds so both liveness deadlines expire; optionally force a private-tunnel path change.
3. Resume the Mac while the Windows runtime and tasks remain running.
4. Confirm the client shows reconnecting rather than a fatal terminal error and all panes recover without manual refresh within 30 seconds of network reachability.
5. Confirm the counters continue across the gap, runtime/terminal PIDs do not change, and unique input markers return only in their target panes.
6. Confirm one snapshot recovery per environment/worktree generation, with no delayed or duplicate input after recovery.
7. Repeat three times with the Mac awake while the network is unavailable beyond the liveness window, then restore it.
8. Repeat with the Windows host unavailable longer than the old finite reconnect budget and verify recovery after it returns.

Evidence attached to the PR must be sanitized. Do not include hostnames, addresses, usernames, filesystem paths, pairing data, task content, or raw screenshots containing private workspace state.

## Verification gates

The stack is ready only when all of the following pass:

- Focused Vitest suites for liveness, shared control, multiplexer, recovery coordinator, and remote PTY transport.
- Typecheck for the desktop/shared/preload surfaces touched by the change.
- Oxc/lint and max-lines ratchet for changed files.
- `git diff --check`.
- The deterministic two-lane blackhole/recovery test.
- The real macOS to physical Windows recovery verifier above.

Any failure caused by the change is fixed before PR creation. An environment-only failure is reported with the exact skipped verifier and reason.

## Rollout and rollback

Deliver this as three linear stacked PRs:

1. pause-aware client/server liveness and shared-control durability;
2. cloneable subscription startup errors and structured dedicated-stream close semantics;
3. the recovery coordinator, terminal rebind/input fencing, and deterministic integration coverage.

The first two PRs reference #8180; only the final PR uses `Fixes #8180`. Each layer keeps the prior one-shot terminal recovery path usable until the final coordinator layer lands. The wire protocol is unchanged, so mixed desktop/runtime versions remain supported. Rollback proceeds in reverse stack order. Reverting the final layer restores the one-shot recovery behavior without persisted-state or server migration work; lower layers can then be reverted independently. The remote PTY is never mutated by the new coordinator, which limits rollback risk.

## Resolved design choices

- **Separate sockets or one socket?** Separate sockets.
- **Retry for a fixed duration or while owned?** While at least one logical pane/subscription owns recovery, with jitter bounded by a 30-second hard cap.
- **Replay user input after reconnect?** No; reject input during recovery and never replay ambiguous bytes.
- **Recreate missing PTYs?** No; only retire a confirmed-gone mirror. Creation remains an explicit user/session action.
- **Use one-shot list or subscription snapshot for recovery?** Coalesced temporary subscription snapshot.
- **Surface transport loss as a terminal error?** No for recoverable failures; yes once for fatal authentication/protocol/confirmed-gone failures.
