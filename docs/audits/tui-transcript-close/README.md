# Closed TUI sessions retain transcript watchers

After a structured session hands off to a terminal, `StructuredTuiTranscriptCatchup` tails the provider transcript. Successful `StructuredAgentSessionHost.close` stopped the TUI owner, durably released its lease, and removed the host session, but did not stop its transcript catchup. The live watcher and catchup state, including the previously seen message IDs, remained reachable. Repeated closes of distinct sessions could accumulate these resources until host teardown.

The fix calls the existing `stopTuiHistoryCatchup` callback after the verified terminal close and durable lease transition succeed. It removes the catchup state and unsubscribes the watcher before later journal eviction. An unverified stop or failed lease write preserves the watcher for retry. A later journal-close failure cannot undo completed watcher cleanup. The execution host retains authority; no client-side inference of remote process death or wire change is involved.

## Reproduce

From the repository root with existing dependencies installed:

```sh
ORCA_BACKGROUND_LAUNCH=1 node docs/audits/tui-transcript-close/reproduce.mjs
```

The proof uses the actual structured host, record store, journal, handoff coordinator, and transcript watcher against a temporary synthetic Codex transcript. Only provider process acquisition/stop is a test transport; no real shell or Orca window launches. It removes the single cleanup call in a temporary Vite transform for the baseline, then runs the same four tests against the fixed source. It uses the repository's `runProcess` and cleans temporary configurations/module files. Source hashes are recorded in `results.json`.

| Version    | Passed | Failed |
| ---------- | -----: | -----: |
| Before fix |      0 |      4 |
| With fix   |      4 |      0 |

The successful-close case observes one added watcher, proves live TUI text reaches the journal, closes the session, verifies the lease is released and session removed, and expects the watcher count to return to its original value. Before the fix it stays one higher. The remaining cases exercise unverified terminal stop/retry, failed durable transition/retry, and failed journal eviction/retry. These are four checks of one cleanup omission.

Existing catchup tests also verify that live appends and recovery of writes made while the host was down remain intact. All seven targeted tests passed, as did the Node typecheck and direct lint.

## Version and limits

Named-path reads of `v1.4.198` confirm that its host close calls the same owner-close helper, that helper omits catchup cleanup, and its catchup owns the same state/watcher lifetime. The executable comparison uses current production source. This establishes a retaining path present in the reported build; it does not establish that either #19831 or #19768 exercised this handoff-and-close sequence, or measure either report's memory growth.

The separate asynchronous acquisition race remains open: teardown calls `stopAll` before draining handoffs, while catchup setup can still be awaiting path resolution or subscription acquisition. Merely rejecting a canceled preparation is insufficient as a full teardown fix: the forward handoff's existing failure recovery may acquire a native replacement, and the handoff drain has a five-second limit. That race needs its own owner-cancellation policy and regression proof; this change covers successful close of an acquired TUI owner.
