# Transcript catchup can outlive host teardown

Host teardown stops TUI transcript catchup before draining in-flight handoffs. Previously, catchup setup registered its state only after asynchronous path resolution and stored its unsubscribe function only after asynchronous subscription acquisition. Teardown could miss either resource. A handoff that had not entered preparation yet could also start a watcher after `stopAll`. Actual-host tests reproduced a surviving watcher after the host session was removed. Stopping an already acquired watcher before its first snapshot instead left preparation waiting indefinitely for that snapshot.

## Ownership fix

Catchup now registers its state before its first await and owns an abort controller throughout setup. It passes the existing resolver/subscriber cancellation signal, releases late subscriptions, settles the initial-ready wait on stop, and preserves a newer same-session acquisition. `stopAll` permanently closes this host's admission; ordinary per-session `stop` still permits a replacement.

Preparation returns its signal internally so the handoff checks cancellation immediately before and after launching a TUI. A dedicated internal cancellation error, while no TUI owner or process identity has been committed, releases the unused reservation through the existing fenced `abandonStoredAgentSessionHandoffAttempt` transition. If launch returns after cancellation with an owner, the existing proven cleanup path is invoked; if cleanup is unavailable or fails, ownership is retained and manual recovery remains required. It leaves a recoverable native lease without acquiring a replacement. This distinction matters: ordinary preparation failure invokes native recovery, and a delayed replacement acquisition can finish after the five-second teardown drain. Ordinary read failures retain that recovery behavior. Canceled recovery of a live TUI stops without retrying or relabeling its live lease, and settles any original durable operation that was still pending.

These are internal lifecycle changes. They add no wire type and infer no remote process death. A launch that remains in flight beyond the bounded teardown drain, and boundary/import I/O already admitted before cancellation, remain outside this change's cancellation guarantee.

## Reproduce

```sh
ORCA_BACKGROUND_LAUNCH=1 node docs/audits/tui-transcript-acquisition/reproduce.mjs
```

The script runs seven tests through the actual host, handoff coordinator, durable record store, journal, and transcript watcher. Real file resolution, watcher installation, and initial read are paused at explicit asynchronous boundaries; provider processes use the existing fake adapter/transport. No real shell or app window launches.

`fix.patch` is reversed inside a temporary Vite transform for the baseline. The new internal error declaration remains available to the same assertions; it does not change baseline control flow. Source hashes and exact failing cases are recorded in `results.json`. Each runner uses a 512 MiB old-space limit, a 90-second deadline, and the repository's cross-platform `runProcess`. The proof requires the fixed runner to exit successfully in addition to matching its seven-pass/zero-fail report. Temporary runner/configuration files and acquired watchers are cleaned up.

| Version    | Passed | Failed |
| ---------- | -----: | -----: |
| Before fix |      1 |      6 |
| With fix   |      7 |      0 |

The five preparation cases cover resolution, subscription return, initial snapshot, admission after teardown, and a completed preparation whose caller has not resumed. The recovery case preserves the live TUI lease. The control delays native acquisition after an ordinary resolver error and verifies the original error and recovery behavior. Six additional ownership tests cover overlapping prepare/recover replacements, per-session restart, repeated shutdown, and the signal returned when no supported record is available. Existing catchup tests preserve live appends and restart gap replay.

Two additional handoff regressions cover a TUI launch returning after cancellation and cancellation during recovery of a pending durable operation. Both fail against the original PR head and pass with the review fix. A late owner is stopped through the existing proven-cleanup contract, then the reservation is abandoned without acquiring a replacement native owner. If cleanup is unavailable or cannot prove the owner stopped, the existing manual-recovery path retains ownership instead. Recovery cancellation marks the original operation failed without relabeling the live TUI lease.

## Version and attribution

Named-path reads confirm the same setup gaps, unguarded forward launch, and stop-before-drain ordering in `v1.4.198`. In that tag the teardown phases are inline in `structured-agent-session-host.ts:254`; current source extracts them into `structured-agent-session-host-teardown.ts`. The executable proof compares current source before/after this fix. It establishes an execution-host watcher retaining path present in the reported version, without proving that #19831 or #19768 exercised this teardown race or explaining either report's memory magnitude.
