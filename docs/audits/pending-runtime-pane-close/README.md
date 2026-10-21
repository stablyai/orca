# Closing an unbound paired-runtime pane with a captured handle

A restored pane can already hold a scoped `remote:<environment>@@<handle>` layout binding while `remote.attach()` waits for `terminal.resolvePane`. The transport's `getPtyId()` is still null. An explicit split close therefore passed null to `closeWebRuntimeTerminal`, removed the layout binding, and destroyed only the viewer. The host terminal stayed connected. This attachment/teardown behavior exists in `v1.4.198`.

This is a specific retained host-terminal mechanism. The change is stacked on the local/direct-SSH pending-close fix in [#21001](https://github.com/stablyai/orca/pull/21001) and reuses its current-owner query. It does not prove the incident frequency in [#15210](https://github.com/stablyai/orca/issues/15210), Linux Electron-main growth, or [#19831](https://github.com/stablyai/orca/issues/19831)'s memory slope.

## Scope and authority

Only an exact scoped handle whose environment matches the owning workspace's runtime authorizes this fix. Existing retirement planning and the shared current-owner query protect other tabs, sibling aliases, and bound transports. The provider helper captures the pairing revision, performs its existing compatibility check, then checks pairing and current ownership again immediately before dispatch. The second call skips only the check that just completed. It sends the existing `terminal.close` request for the captured handle.

The actual host fixture verifies that re-registering the same PTY ID with a new incarnation allocates a new handle. A close addressed to the old handle rejects and never invokes the controller's kill operation. Client same-leaf adoption, a replaced transport map, and changed worktree/pairing ownership also suppress the queued request. Ordinary detach remains viewer-only.

Native host PTY hints, legacy handles without an explicit environment, and returned different handles are outside this fix. Current client snapshot registries retain freshness/frame identity rather than a live terminal-row incarnation. Inferring destructive authority from a late native-hint resolution could stop a replacement. The separate read-only native-hint and pending web-activation reproduction remains in `notes/paired-pending-split-close`; it establishes omitted requests, with no claim that these excluded cases are fixed. No parent-tab close, local fallback, new wire field, or capability is introduced. A request is not confirmation of process death; provider failures retain their existing handling.

## Close-confirmation review correction

The public split-close callback now probes the captured scoped handle before authorizing retirement, including while `terminal.resolvePane` remains pending. Live or unverified pending work opens the existing confirmation dialog. Cancel keeps the host terminal; Confirm rechecks the captured tab, pane, transport, handle, host, and pairing revision. A replacement or a split that became the only pane invalidates the old decision. The host's existing handle-incarnation fence and the compatibility-dispatch checks remain in force.

`pending-pane-close-confirmation.test.ts` adds public-callback controls for both local/direct-SSH and paired pending panes. The comparative counts below remain the original proof snapshot, which called the post-confirmation `executeClosePane` callback directly.

## Reproduce

Run in the repository root with existing dependencies:

```sh
ORCA_BACKGROUND_LAUNCH=1 node docs/audits/pending-runtime-pane-close/reproduce.mjs
```

The script runs 13 tests using the actual split-close hook and remote transport, plus two tests delivering the close RPC into an actual `OrcaRuntimeService` with a fake PTY controller. React registration and unrelated presentation callbacks are mocked. No Electron window, host process inventory, or real PTY child is used.

The temporary Vite transform reverses only `fix.patch`; the baseline includes the IPC fix from #21001. Working sources remain untouched. The script uses the shared cross-platform process runner and records source hashes and exact cases in `results.json`.

| Version                  | Passed | Failed |
| ------------------------ | -----: | -----: |
| Before scoped-handle fix |      5 |     10 |
| With scoped-handle fix   |     15 |      0 |

The baseline failure count includes new eager-request/compatibility assertions, not ten independent leaks. Additional validation: 255 tests in 21 selected renderer suites, full renderer typecheck, direct lint, and the changed-code quality gate pass. The original 24-case IPC proof still runs after the shared ownership extraction; its committed results remain a snapshot of the published IPC source.
