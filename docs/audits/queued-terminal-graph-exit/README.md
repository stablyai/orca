# Queued renderer graph restores an exited pane owner

This is a separate source-level explanation for part of [#19018](https://github.com/stablyai/orca/issues/19018). It reproduces an execution host certifying exit, followed by a queued renderer graph restoring that PTY's runtime `connected` flag and making the actual stable-pane resolver throw `terminal_pane_owner_conflict` against the successor's durable binding.

## Run

From the checkout, with installed dependencies:

```sh
ORCA_BACKGROUND_LAUNCH=1 node docs/audits/queued-terminal-graph-exit/reproduce.mjs /tmp/queued-terminal-graph-exit.json
```

The script uses the real renderer graph publisher, main `Store.persistPtyBinding`, runtime, daemon server, adapter, and local sockets. Only the subprocess and the IPC dispatch boundary are controlled. It creates temporary data/socket paths, runs hidden Node tests, and removes its scratch files. It does not launch an Electron window or install dependencies. The JSON records source hashes and excludes randomly allocated terminal handles/incarnations.

## Ordering

1. Publish the mounted predecessor's graph normally.
2. Capture its next unchanged publication at the IPC dispatch boundary. The real publisher sends the mounted leaf, `mobileSessionTabs: []`, and `unchangedMobileSessionWorktrees`.
3. While that publication is queued, spawn a successor and durably bind it to the same tab and leaf.
4. Deliver the predecessor's physical daemon EXIT. The runtime becomes disconnected with an `exited` verdict.
5. Deliver the already-captured graph, without reordering renderer publications.
6. Resolve the pane, query the owning daemon's fresh inventory, and publish once more. A second variant unmounts the renderer terminal before that inventory and remounts it afterward through the real registration/publisher API.

The replacement-binding commit and the daemon EXIT can run while a renderer invocation is queued. The production spawn commit persists the binding before returning its reply (`ipc/pty/ipc/spawn-commit-persist.ts`); the graph publisher reads the mounted pane's transport independently. The fixture controls that ordering; it does not prove its frequency on the reporting machine.

Retirement correctly refuses to delete the successor's durable binding. Before the fix, the retained surface coordinates then allow the old graph leaf to set the predecessor connected again. A healthy inventory contains only the successor, but the runtime sweep skips records that still have a graph leaf. The list's presentation can label that leaf disconnected while the underlying pane resolver still sees it connected.

## Results

| Variant         | First queued graph restores predecessor | After unmount, inventory, and remount | Pane conflict     |
| --------------- | --------------------------------------- | ------------------------------------- | ----------------- |
| Before          | yes                                     | yes                                   | yes               |
| Exit check only | no                                      | yes                                   | no at first check |
| Complete fix    | no                                      | no                                    | no                |

All three variants also run an ordinary-exit control without a replacement; it remains retired throughout. The middle variant isolates why a weak inventory absence during a renderer mount gap must preserve an already-earned exit certificate. Without that mount gap, the retained disconnected leaf keeps the inventory sweep from forgetting the verdict.

The fix reuses the existing liveness verdict registry to keep an exited graph leaf disconnected and nonwritable, and skips recreating its PTY/URL-watcher ownership. It preserves surface membership: a separate actual `stopExactTerminalsForWorktree({ keepHistory: true })` control passes a changed renderer-built mobile snapshot while physical exit has completed but the stop reply is pending. The history surface remains present before and after the renderer clears its PTY binding. All phases check this control; the fixed phase also checks that mobile projection never combines one PTY's ID with another PTY's handle.

Fresh spawn/registration clears the prior verdict; an owning inventory can establish `live`. A physical exit still records its certificate if the bounded PTY archive was already pruned. Host-only tests cover same-ID replacements, stale predecessor EXIT, fresh renderer-only panes, physical negative exit codes, local unverified stops, SSH disconnects, and retained history. The portable proof runs 15 actual-runtime cases across its three source variants.

## Limits and version evidence

The relevant graph admission, unconditional graph-connected write, durable retirement refusal, and inventory leaf exception are present in the reported **v1.4.197**. That tag already passes `providerExitObserved` from local and daemon physical exit callbacks and computes `processDeathCertified`; this proof's natural-exit path does not depend on #21000's synthetic-notification correction. Executable before/after runs use the current checkout with narrowly asserted source transforms, not the complete historical binary.

This proves stale runtime/pane ownership, not a measured native-process or heap leak. The graph alone does not recreate a headless terminal model. It does not establish that every missing diagnostics row denotes an exited process, nor explain all handle-count growth in the issue.

The existing register retains at most 256 unowned verdicts; PTY/handle/leaf owners keep their verdicts until their own lifecycle ends. The disconnected PTY archive is capped at 128. After both a record and its bounded verdict are evicted, the graph has no remaining per-ID certificate; this change does not add permanent tombstones. Later loss-of-contact writes can still replace an exit verdict with `unverifiable`; a stale positive inventory can separately write a connected record. Those paths are not exercised or fixed by this local queued-publication proof.

A separate audit found that an unreachable unrelated legacy daemon can make aggregate exact-stop verification fail despite absence on the target's own daemon. That is excluded from this fix and from the proof's healthy target-inventory assertion.

## Recorded run provenance

`results.json` records the graph fix before the separate provider-inventory lifecycle fence in #21014. Its source hashes identify that earlier run; they are not a claim that every later audit commit has the same bytes. The reproduction can be rerun against the combined worktree.

## Pull request dependency

The graph PR is stacked on #21000, reusing its daemon socket fixture and physical-exit delivery contract. The graph mechanism is separate; the stack makes the executable proof dependencies explicit.
