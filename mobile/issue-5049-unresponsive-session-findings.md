# Issue #5049: Android Remote Session Unresponsiveness — Findings

Date: 2026-06-09
Issue: https://github.com/stablyai/orca/issues/5049

## Reported symptoms

Android + Tailscale remote session intermittently becomes unresponsive: tab/worktree
taps do nothing, pasted text doesn't execute, the connection "appears stuck instead
of clearly disconnected", and closing/reopening the app restores the session.

## Root causes found (mobile-side)

All three independently produce the exact reported symptom — a session that looks
alive but ignores input, recoverable only by an app restart:

1. **Parked reconnect loop with no recovery path (primary).** `rpc-client.ts`
   stops retrying permanently after `GIVE_UP_AFTER_ATTEMPTS` (12 attempts ≈ 6.5 min
   of backoff). Android backgrounding + Doze + a Tailscale tunnel drop routinely
   burns through all 12 attempts while the user is away. Nothing ever restarted the
   loop: there was **no AppState listener anywhere in the transport layer**, so
   returning to the foreground did not nudge the client. The state stays
   `'reconnecting'` forever ("appears stuck instead of clearly disconnected").
   Reopening the app creates a fresh client with a fresh attempt budget — which is
   exactly why "closing and reopening usually restores the session".

2. **Half-open socket detection waits up to ~28s, and never starts earlier on
   resume.** Android can kill the TCP path while backgrounded without delivering
   `onclose`; `readyState` still reads OPEN, so every `terminal.send` (e.g. paste)
   silently blackholes. The activity probe (20s interval + 8s timeout) eventually
   reaps the link, but the first ~28s after resume look like "pasted text does not
   run immediately" / "switching is very slow".

3. **Stale client after `forceReconnect` (pre-existing `useHostClient` bug).**
   `forceReconnect` swaps in a fresh `RpcClient`, but `useHostClient` only re-read
   the client when its ref was still `null`. Any mounted screen kept driving the
   old, **closed** client forever: the status header (fed by provider-level state
   listeners) shows "Connected" while every RPC instantly fails with "Client
   closed" — a session that looks alive but ignores all input.

   Additionally, the session screen (where users actually live) had no recovery
   affordance at all: just a status label, while the Retry buttons exist only on
   the home/host/tasks screens.

## Fixes

- `src/transport/rpc-client.ts` — new `notifyForeground()`:
  - state `connected` → restart the probe interval and run one probe immediately
    (half-open link reaped in ≤8s instead of ≤28s);
  - state `reconnecting` → clear any pending backoff timer, reset the attempt
    budget, reconnect immediately (un-parks the give-up cap).
  - (Also extracted the duplicated close/error event serialization into
    `socket-event-debug.ts` to stay under the file's line cap.)
- `src/transport/client-context.tsx`:
  - `RpcClientProvider` now listens to AppState and calls `notifyForeground()` on
    every live client when the app becomes active.
  - `useHostClient` re-reads the underlying client on every state change, so
    screens pick up the fresh client after `forceReconnect` instead of driving a
    closed one.
- `app/h/[hostId]/session/[worktreeId].tsx` — the status row in the session header
  becomes tappable once `classifyConnection` escalates to warning/unreachable,
  showing "<label> — tap to retry" and invoking `forceReconnect`.

## Repro harnesses

- `src/transport/rpc-client.test.ts` → `foreground recovery` describe block:
  deterministic fake-timer repro of the parked loop (proves it never self-recovers)
  plus regression coverage for all `notifyForeground()` paths.
- `src/transport/rpc-client-live-recovery.test.ts`: opt-in live harness running the
  REAL rpc-client (real sockets, real tweetnacl E2EE, real timers) against an
  in-process ws server with a blackhole toggle:
  - `ORCA_MOBILE_LIVE_REPRO=1 pnpm vitest run src/transport/rpc-client-live-recovery.test.ts`
    — half-open-link scenario (~15s).
  - `ORCA_MOBILE_LIVE_REPRO_FULL=1 …` — full parked-loop scenario (~8.5 min): waits
    out all 12 backoff attempts, proves the loop stays parked even after the server
    returns, then proves `notifyForeground()` recovers it.

## Not addressed (out of scope, noted for future work)

- The diagnostics in `rpc-client.ts` mention a suspected RN/OkHttp process-state
  poisoning mode (every open instantly fails with 1006 until force-quit). If that
  mode is real, a foreground nudge reconnect attempt would also fail; the existing
  `[net]` logs (wsCount / msSinceLast\*) are designed to confirm or rule it out from
  device logs.

## Follow-up audit (same PR)

- `connection-revival-triggers.ts` (via `expo-network`) extends the foreground
  nudge to network restoration and Wi-Fi → cellular handoffs.
- Files and source-control screens' Retry buttons now revive the transport
  (`forceReconnect`) when disconnected instead of pointlessly re-sending the
  request into a parked connection.
