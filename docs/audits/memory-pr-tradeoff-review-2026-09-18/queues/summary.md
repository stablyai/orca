# Queue tradeoff removal review

All three original PRs remain held. Under sustained overload, their live, undelivered input cannot disappear while preserving every byte, uninterrupted producer progress, and bounded resources. The existing replay mechanisms do not preserve the complete affected streams. Moving retention to disk or another process, increasing caps, and compression all retain costs or the eventual overflow problem.

| Original PR                       | Can all tradeoffs be removed locally?                                                                                                              | Concrete outcome                                                                                                                                                          |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #20947 daemon stream backpressure | No: stalled output subscribers can still block PTY producer progress. Existing snapshot/history recovery is bounded and loses intermediate events. | Extracted a separate **64 production LoC cleanup-only candidate** that retires refill tokens and ignores stale socket callbacks. It does not solve live payload overload. |
| #20949 CDP outbound backlog       | No: general CDP events and command results have no replay owner. Pausing page activity, disconnecting, or dropping events changes behavior.        | Keep held. Removing only termination would silently discard the queue while leaving the connection open and permanently unable to enqueue.                                |
| #21129 speech audio backlog       | No: a live microphone cannot be paused without losing future speech. Current overload error can also suppress accepted final transcript.           | Keep held. A larger graceful-stop contract could preserve more already-admitted transcript, but still stops capture and cannot drain a permanently hung decoder.          |

## Separate cleanup candidate

- Base: `99071175698dead2566d613bc52393b5e3c373a0`.
- Patch: [20947/cleanup-only.patch](20947/cleanup-only.patch).
- Files and hashes: [20947/candidate-manifest.json](20947/candidate-manifest.json).
- Reuses the already-reviewed `DaemonStreamHeldRefill` implementation from #20947; no new backpressure, byte limit, protocol frame, timeout or loss policy.
- Exact baseline: **3 expected failures / 1 pass**. Clearing 200 clients retains 200 refill IDs; a retired callback flushes its successor; shutdown callbacks flush retired owners.
- Fixed candidate: **31 tests / 3 files pass**; ordinary lint and anti-slop lint pass. Tests include live output preservation, byte order, and droppability behavior. Full project typecheck is left to central publication validation.
- The owner map releases its references immediately; pending socket callbacks themselves remain governed by socket completion. This is a lifecycle fix, not a claim that all pending socket allocations vanish.

## Evidence

Exact published-head controls: **#20947: 35 tests**, **#20949: 6 tests**, **#21129: 15 tests**, all pass. CDP controls include real localhost sockets. The final candidate adds 31 focused checks. All test/app commands used `ORCA_BACKGROUND_LAUNCH=1`; no visible app was launched.

Per-PR reports contain exact heads, caller/replay review, discarded alternatives and limitations:

- [20947/report.json](20947/report.json)
- [20949/report.json](20949/report.json)
- [21129/report.json](21129/report.json)

[provenance-check.json](provenance-check.json) verifies every dynamically loaded repository source against its named Git head; the candidate overlay hashes are in its test log and manifest. Installed package versions are local. No SSH mixed-version integration, native speech recognition, or cross-platform matrix was run.
