# Terminal Main-Owned State

This document covers the hidden-output recovery slice. The broader terminal
model/view boundary is defined in
[`reference/terminal-model-view-contract.md`](./reference/terminal-model-view-contract.md).

## Problem

Hidden and background terminal panes cannot rely on renderer memory as the only
place that terminal output exists. Chromium may throttle a hidden Electron
document while the PTY continues producing bytes. If the renderer retains every
hidden byte until xterm can parse it, a noisy terminal can pin large strings in
renderer memory and stall or crash the app.

The renderer must keep a hard memory bound, but the user-visible terminal state
should still be recoverable when the pane becomes visible again.

## Reference Pattern

Use a host-owned terminal model as the recovery source and treat the renderer as
a view:

- The host process receives PTY bytes first and appends them to a bounded
  headless terminal model.
- The renderer writes visible output directly for low latency.
- Hidden renderer queues are bounded. When they overflow, the renderer marks its
  xterm as stale and drops further hidden bytes instead of retaining them.
- On visibility resume, the renderer asks the host for a serialized snapshot,
  clears its xterm, replays that snapshot, then resumes live writes.
- Live output racing with restore carries a monotonic sequence number, so bytes
  already included in the snapshot are not written twice.

This gives the foreground path the same latency profile as today, bounds hidden
renderer memory, and preserves terminal state from the host-owned model instead
of depending on an unbounded renderer backlog.

## Requirements

- Renderer hidden-output memory is capped per terminal.
- A hidden flood must not grow the renderer by retaining strings or chunk arrays
  past the cap.
- Restoring a stale renderer must use main/runtime state for local, daemon, and
  SSH PTYs.
- Remote runtime PTYs that do not have local main-owned state must keep the
  existing warning fallback rather than pretending recovery is available.
- Restore must avoid xterm query auto-replies reaching the shell.
- Clear, resize, exit, and pane disposal must clean up recovery state.
- The SSH path must participate in the same sequencing and snapshot behavior as
  local PTYs.

## Chosen Design

The existing runtime headless terminal is the main-owned model. Every PTY byte
already reaches `OrcaRuntimeService.onPtyData` before renderer delivery for
local, daemon, and SSH PTYs. That path keeps a headless xterm emulator updated
and can serialize it.

Since the hidden-delivery gate shipped (`terminalHiddenDeliveryGate`, default
on — see the contract's Architecture Status), main drops hidden renderer-bound
bytes after model ingestion and emits an out-of-band restore marker, so a
gated hidden pane accumulates no renderer backlog at all. The overflow path
below is the fallback for kill-switch-off mode and for hidden PTYs with an
active delivery-interest sidecar.

The renderer scheduler keeps its 2 MB background cap. When the cap is exceeded:

1. The scheduler replaces the queued backlog with a small warning fallback.
2. The terminal connection marks that pane as needing main-state recovery.
3. Further hidden bytes for that stale pane are not enqueued in the renderer.
4. When the pane/document becomes visible, the connection requests a main-owned
   snapshot, clears xterm, replays the snapshot under the replay guard, and
   sends the normal post-reattach reset.
5. Live foreground chunks that arrive while restore is in flight are retained in
   a small bounded queue. After snapshot replay, sequence numbers decide which
   chunks were already included and which still need to be written.

If the main snapshot is unavailable, the small warning fallback remains the
visible behavior. That is the expected fallback for surfaces without local
main-owned terminal state.

## Non-Goals

- This does not add a durable full byte log. The host-owned model is bounded
  terminal state, not an infinite transcript.
- This does not throttle the PTY producer. Producer backpressure can be added
  later with ACKs if we need to reduce host-side work during extreme floods.
- This does not change foreground terminal write latency.

## Verification

- Unit-test scheduler overflow callback behavior and chunk-count bounding.
- Unit-test renderer recovery so hidden overflow drops renderer backlog, fetches
  the main snapshot on visibility/foreground resume, and does not duplicate
  sequenced live output.
- Unit-test main IPC snapshot sequencing.
- Run terminal scheduler and PTY connection tests.
- Run typecheck.
- Exercise the Electron hidden-flood repro and confirm renderer memory stays
  bounded while the recovered terminal shows the host-owned terminal state.
