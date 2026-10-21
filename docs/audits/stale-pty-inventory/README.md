# Stale provider inventory overwrites newer PTY ownership

A provider inventory started before a process exit can finish afterward and reconnect the exited runtime record. If a replacement was admitted under the same ID, the old response can also overwrite its incarnation, invalidate its terminal handle, and clear its pane binding.

This is a separate source-level explanation for stale terminal ownership such as [#19018](https://github.com/stablyai/orca/issues/19018). The proof does not establish the cause of [#19768](https://github.com/stablyai/orca/issues/19768) or [#19831](https://github.com/stablyai/orca/issues/19831), or measure their reported memory growth.

## Reproduce

From a checkout with dependencies installed:

```sh
ORCA_BACKGROUND_LAUNCH=1 node docs/audits/stale-pty-inventory/reproduce.mjs
```

The script runs the actual runtime inventory, registration, spawn, and exit methods with deferred provider responses. It uses temporary Vitest configuration to reverse only `fix.patch` for the baseline, leaves checkout files untouched, and removes its temporary files. It launches no app, enumerates no real processes, and installs nothing. Node subprocesses use the repository's portable `runProcess` implementation.

`results.json` records source hashes and the before/after result: **16 failing / 6 passing tests before; all 22 passing after**.

## Retaining and ownership path

1. `refreshPtyWorktreeRecordsWithControllerInventory` starts a provider request and captures its generation and liveness observation sequence.
2. While the response is pending, `onPtyExit` records a physical exit. A subsequent `registerPty` or `onPtySpawned` may admit a successor, including one absent from the runtime when the request began.
3. The original inventory returns its older row. Previously, the verdict setter's observation check did not protect the rest of the row processing: handle adoption ran, and `recordPtyWorktree` wrote `connected: true` and the old incarnation.

For an exit without replacement, the record could therefore be connected while its verdict still said `exited`. A later empty listing skips the disconnected-record sweep while a graph leaf remains. In the successor case, `adoptControllerTerminalHandle` can invalidate the new handle before the old incarnation is written. Fresh positive inventory can restore the successor handle and incarnation; it cannot reconstruct cleared pane coordinates without binding evidence.

The proof exercises these mutations directly. It does not recreate a native process or a headless terminal model. Consequently, it demonstrates incorrect ownership and potential retained records, rather than a quantified heap or native-process leak.

## Fix and controls

Accepted spawn, registration, and exit events now invalidate pending inventory for their provider through the existing provider generation registry. The existing stale-response check runs before handle adoption, record mutation, or construction of an authoritative live-ID result.

The response is rejected as a whole, so filtered rows cannot become false evidence of absence. A targeted worktree read retries at most once using its original deadline; another invalidation yields an unknown result. A targeted different-host query remains valid. Aggregate requests conservatively reject when a provider changes during the request. This can reject a response that happened to include the newly admitted process; a subsequent fresh request remains authoritative.

The tests cover stale positive rows, stale absence, unknown-at-request-start spawns, registrations with no incarnation, ignored predecessor EXIT, exported handle preservation, fresh discovery and replacement, local/SSH routing (including SSH aliases with spaces, `@`, and `:`), concurrent provider generations, and bounded retries. Existing partial-relay and liveness tests verify that failed contact is not promoted to process death. The change adds no permanent per-PTY registry and changes no wire fields or liveness vocabulary.

## Version and scope

The relevant await, guarded verdict update, unconditional handle/record updates, and spawn/registration verdict deletion exist in **v1.4.198**. That version forgot the prior verdict on a positive inventory row; current code records `live`. Both versions leave subsequent mutation outside that observation fence. The executable baseline is current source with the narrow fix reversed, not a historical application binary.

The graph-publication fence is a separate fix. Later loss-of-contact writes and independent paths that query provider inventory directly remain outside this patch. Incident frequency and the reporting machines' actual ordering are unproven.
