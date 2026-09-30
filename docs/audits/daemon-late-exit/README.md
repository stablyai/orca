# Delayed daemon output after a synthetic exit

A daemon stop response can arrive on its control socket before its final DATA and
EXIT events arrive on the separate stream socket. Main then emits a synthetic exit.
The delayed DATA recreates a headless model and marks the runtime PTY connected;
the old duplicate-exit check suppresses the physical EXIT before runtime cleanup.
The host has no live session, but main retains the connected record, title tracker
and headless terminal.

## Reproduce

From the checkout, using its installed dependencies:

```sh
ORCA_BACKGROUND_LAUNCH=1 node docs/audits/daemon-late-exit/reproduce.mjs /tmp/daemon-late-exit-results.json
ORCA_BACKGROUND_LAUNCH=1 node node_modules/vitest/vitest.mjs run --config config/vitest.config.ts src/main/ipc/pty/daemon-late-exit.test.ts
```

The script uses the real daemon server, client, provider, socket pair, kill IPC
handler, listener binding, and runtime. The native subprocess boundary is a fixture
whose force-kill callback reports exit. Pausing only the stream reader makes the
independent control/stream ordering deterministic. No renderer or visible app is
launched. Temporary Vitest files are removed afterward.

The before case moves duplicate suppression back ahead of runtime cleanup in the
loaded module only. It retains the current incarnation-aware marker representation,
which does not affect the same-incarnation race. The on-disk source stays unchanged.
The script verifies its transform boundary and records the current source hash.

## Results

[results.json](./results.json) contains four before/after controls:

| Scenario                                                 | Before                                                 | After                                  |
| -------------------------------------------------------- | ------------------------------------------------------ | -------------------------------------- |
| Kill reply overtakes queued DATA and EXIT                | Connected; headless model and title tracker retained   | Disconnected; both released            |
| Host inventory verifies exit before queued DATA and EXIT | Connected despite an `exited` verdict; models retained | Disconnected; models released          |
| Kill reply overtakes EXIT with no queued DATA            | Disconnected; cause remains `stop_unverified`          | Disconnected; confirmed requested stop |
| Natural DATA then EXIT                                   | Disconnected; models released                          | Same                                   |

All eight runs receive one physical provider exit, deliver all final output to the
renderer admission boundary, send one renderer exit, and call the runtime exit
listener once. Fresh daemon inventory is empty in all cases. Additional regression
tests cover same-ID replacement, stale provider callbacks, legacy unstamped exits,
and one-time dispatch settlement with the real SQLite orchestration database.

The fix always processes the current incarnation's provider exit in main. Duplicate
suppression applies only to the renderer notification. When the provider supplies an
incarnation, its marker names that stopped incarnation and cannot suppress a
differently stamped replacement's exit. Legacy unstamped events retain their
existing matching behavior. A matching marker restores the original stop intent
while normal exit-cause resolution still handles negative,
unconfirmed exits. No output is dropped and no wire fields or opcodes change.

## Report correlation and limits

The early-return listener and synthetic renderer-kill exit are present in both
`v1.4.197` (#19018) and `v1.4.192` (#17344). The reproduced `connected: true` plus
`stop_unverified` state matches #19018's reported contradiction and provides a
concrete main-process retaining path relevant to #19831. This does not prove which
ordering occurred in either user's session, explain #19018's failed subsequent
inventory/close reconciliation, or by itself prove persisted tab resurrection in
#17344. A missing `diagnostics.memory` row is not process-exit evidence; this proof
uses the owning daemon's physical exit and fresh session inventory.

A second runtime cleanup may advance an already-retired surface's topology revision
once more. It does not republish a removed surface. Existing exit listeners and
waiters remove themselves on settlement; completed dispatches are no longer active.
The existing marker timeout remains 30 seconds. The separate asynchronous shutdown
call's ownership across its await is outside this change.
