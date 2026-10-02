# Pending split close can omit shell retirement

A restored split pane can be explicitly closed while its IPC spawn/reattach reply is pending. Its transport has no bound PTY ID yet. The old close path deleted the durable leaf binding and destroyed the unbound transport without requesting retirement. The late-result cleanup deliberately preserved reattach and cold-restore replies for remounts, so an existing shell or newly cold-restored shell could remain live with no pane and no kill request.

This is a concrete mechanism matching the **missing kill requests** in [#15210](https://github.com/stablyai/orca/issues/15210). The relevant close, late-result exclusion, and daemon cold-restore behavior exists in both `v1.4.184` and `v1.4.198`. The report does not establish that this sequence produced its 51 shells. It also does not establish a retained Electron-main heap slope or independently explain [#19831](https://github.com/stablyai/orca/issues/19831).

## Ownership and fix

The explicit split-close hook captures its durable requested PTY before removing the leaf binding. Existing tab-retirement planning resolves the local/direct-SSH execution owner. It requests retirement immediately and retains an explicit-close callback for the late same-ID result. The late callback rechecks current store ownership and the current transport map, including a replacement at the same leaf. It makes a second request only when no owner remains.

An eager request alone is insufficient: Electron spawn preflight can still be waiting before the adapter/history lock exists. A kill can return `SessionNotFoundError`, then the pending spawn creates a new cold-restored shell. The late-result request closes that window. If spawn already owns the adapter's history lock, the ordinary known-ID shutdown waits behind it; the control case preserves that behavior.

Generic detach/destroy keeps its existing behavior. Repeated destroy retains explicit intent, while a different returned reattach identity remains protected. The tab aggregate/row ID is not counted as a separate same-tab owner; it can be the closing leaf's own stale index. Other live tabs use all existing retirement ownership sources; remote alias matching reuses the existing normalized identity.

Paired-runtime handles, runtime-owned native hints, and unresolved owners never fall through to local kill. They are outside this IPC fix. A provider failure is logged by the existing retirement helper; requesting retirement is not confirmation of process death. No host inventory sweep, wire change, global tombstone, or remount-driven shutdown is introduced. A shared owner already present at close keeps its established retirement responsibility; this does not change all pending-fresh/shared-owner races.

## Close-confirmation review correction

The original tests called `executeClosePane` after a close decision. A separate review found that the public `handleRequestClosePane` callback skipped the running-work check while the transport was still unbound. Retirement now obtains the pending local/direct-SSH identity from the existing retirement plan and runs the existing confirmation flow first. An unverified pending probe asks for confirmation; Cancel preserves the process. Before a delayed decision or confirmation acts, the captured tab generation, pane, transport, binding, and execution owner must still match. A split that became the final pane cannot turn an old confirmation into a whole-tab close.

`pending-pane-close-confirmation.test.ts` exercises the public callbacks, including live and unverified work, Cancel, confirmed close, completed attachment, ownership replacement, and direct SSH. These are separate regression controls added after the original comparative proof below; they do not change its historical case counts.

## Reproduce

From the repository root with the existing dependencies installed:

```sh
ORCA_BACKGROUND_LAUNCH=1 node docs/audits/pending-split-close/reproduce.mjs
```

The script runs the actual close hook, layout binding, pane-close handler, IPC transport, daemon server, and daemon adapter. React registration and unrelated presentation/status callbacks are mocked. Daemon cases use temporary sockets, synthetic history, and the existing fake subprocess fixture; no real shell or Orca window is launched. It cleans its temporary configuration and invokes Vitest through the repository's cross-platform `runProcess`.

`fix.patch` is reversed only inside a temporary Vite source transform for the baseline. Working files remain unchanged. New helper/test sources remain present, but the baseline close hook cannot call the helper. Source hashes and exact cases are recorded in `results.json`:

| Version | Passed | Failed |
| --- | ---: | ---: |
| Before fix | 10 | 14 |
| With fix | 24 | 0 |

The 24 cases retain the original nine reproduction/control scenarios and add same-leaf/new-map/different-tab adoption, sibling ownership, repeated destroy, provider failure/retry, spawn rejection, returned-ID mismatch, direct SSH, unresolved/paired-runtime routing, and folder workspace coverage. Eight separate ownership-query tests cover legacy/scoped aliases and the existing tab ownership sources. The baseline failures include assertions about the new eager request; they are not 14 independent leaks.

Historical entry points: `v1.4.184` `TerminalPane.tsx:1163`, `use-terminal-pane-lifecycle.ts:1368`, `pty-transport.ts:859`, and `src/main/daemon/daemon-pty-adapter.ts:750`. The current equivalents are `use-terminal-pane-close-actions.ts`, `terminal-pane-pane-closed.ts`, `ipc-pty-connect.ts`, and `daemon-pty-spawn-result.ts`.
