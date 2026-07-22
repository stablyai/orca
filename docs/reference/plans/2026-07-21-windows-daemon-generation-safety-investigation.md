# Windows daemon-generation safety investigation (#9749)

Investigation and completion snapshot: 2026-07-21 16:59 PDT
(2026-07-21 23:59 UTC)

Branch baseline: `OrcaWin/issue-9749-windows-daemon-generation-safety` at
`937a2015e`, 40 commits after `v1.4.148-rc.1`. This document is the hard gate
before a reproduction harness or production change. GitHub access during the
investigation was read-only, and no installed Orca daemon, pipe, token, process,
or terminal session was contacted or changed.

## Findings

The reported incident is a composition of three lifecycle paths, not one:

1. **Survival and adoption:** normal app quit deliberately disconnects from
   daemon clients without shutting down their PTYs. Protocol-specific named
   pipes let multiple generations coexist, and legacy adapters intentionally
   reconnect to them so live PTYs remain warm and reattachable across upgrades.
2. **Broad current-generation replacement:**
   `cleanupDaemonForProtocol` sends the only production
   `shutdown { killSessions: true }` request found in the repository. Its
   production callers replace or explicitly restart the current generation;
   legacy discovery does not call it. A failed `listSessions` is currently
   converted to an empty list before this broad shutdown, which makes its
   reported kill count untrustworthy but does not suppress the shutdown.
3. **Reconnect-triggered per-session destruction:** #8871 provides the strongest
   causal evidence. A reconnecting renderer restores stale remote handles,
   synthesizes `pty-exit`, drops that reason at `session.tabs.close`, and the
   authoritative host interprets the close as user intent. Its PTY router then
   forwards individual `kill` requests to whichever current or legacy adapter
   claimed each reusable session ID during discovery.

`client-hello` is necessary to discover and route legacy sessions, but neither
the hello handler nor legacy discovery sends a kill or shutdown request. The
~3.3-second renderer-bootstrap-to-kill evidence in #8871, repeated renderer
spawn/burst correlations, and the untyped close path are substantially stronger
than #9749's inference that greeting an old pipe causes that daemon to kill its
table autonomously.

The immediate safety boundary is therefore destructive request authority and
provenance. Cross-profile, sleeping-session, and generation-retirement policy
remains the larger #9138/#9229 problem.

## Deterministic native-Windows reproduction

Reproduction snapshot: 2026-07-21 14:36 PDT (2026-07-21 21:36 UTC).

`tests/e2e/daemon-generation-reconnect-safety.spec.ts` now constructs an
isolated `orca-9749-dg-*` runtime under the Windows temporary directory. It
starts three real daemon-server processes on versioned v21/v22/v23 named
pipes, with a live canary and a stale-mirror canary in each generation. Each
canary records the PTY-root and descendant PID/start identity independently.
The fixture refuses cleanup outside its exact temporary root and terminates
only recorded fixture process incarnations; it never enumerates or connects to
installed Orca endpoints.

The Electron-as-Node reconnect client performs three production
`DaemonPtyAdapter`/`DaemonPtyRouter.discoverLegacySessions` bursts, reattaches
every original PID, pings every canary, and opens a simultaneous second client
to each generation. It then sends duplicate `session.tabs.close` RPCs carrying
`reason: 'pty-exit'` through the real schema, `OrcaRuntimeService`, and routed
daemon adapters while the reconnect-client process remains alive.

The current-main run failed at the intended external invariant:

- before the close, all three daemons, six PTY roots, and six descendants were
  alive;
- each daemon accepted eight new control/stream hellos across the reconnect and
  parallel-client cycles;
- v21, v22, and v23 each logged two `session-killed` requests for the same
  stale-mirror session ID within 1–4 ms;
- all three stale-mirror PTY roots and descendants exited, while all three
  unrelated live canaries, all daemon processes, and reconnect client PID 26876
  remained alive;
- the final assertion requires those stale-mirror roots to remain alive, so it
  is RED before the fix and will become GREEN only when lifecycle-originated
  closes are adjudicated non-destructively at the host.

Focused command:

```text
pnpm exec playwright test tests/e2e/daemon-generation-reconnect-safety.spec.ts --config tests/playwright.config.ts --project electron-headless --workers=1
```

The captured per-generation timestamp/PID/hello/kill/liveness report is written
to the Playwright test output as `daemon-generation-reconnect-events.json`.

## Release and protocol chronology

| Release or branch     | Date       | Daemon protocol | Relevant lifecycle behavior                                                                                                |
| --------------------- | ---------- | --------------: | -------------------------------------------------------------------------------------------------------------------------- |
| `v1.4.141`            | 2026-07-14 |              21 | Legacy adoption already intentional; #8871 observed here.                                                                  |
| `v1.4.142`            | 2026-07-15 |              22 | New versioned endpoint; v21 can remain reattachable.                                                                       |
| `v1.4.143`            | 2026-07-16 |              22 | #9138 macOS accumulation reported.                                                                                         |
| `v1.4.144`            | 2026-07-17 |              22 | #9195 Windows survival reported.                                                                                           |
| `v1.4.145`            | 2026-07-18 |              22 | No generation-retirement change.                                                                                           |
| `v1.4.146`            | 2026-07-19 |              23 | #9749's old current generation; already contains #8661's continue-shutdown-on-dispose-failure behavior.                    |
| `v1.4.147`            | 2026-07-20 |              24 | First stable release containing #9277: authenticated identity and atomic empty-daemon retirement.                          |
| `v1.4.148`            | 2026-07-21 |              24 | Reporter current release; legacy v23 and older remain intentionally adoptable.                                             |
| `main` at `937a2015e` | 2026-07-21 |              25 | Protocol bumped by #9651 (`cc44acaaa`) for PTY startup ingress; v24 is now legacy. No stable tag contains this commit yet. |

`PREVIOUS_DAEMON_PROTOCOL_VERSIONS` is cumulative rather than one-version-only.
At the investigated `main`, it contains versions 1 through 24.

## Investigation matrix

Confidence is **proven** when the issue evidence and source/diff establish the
mechanism, **supported** when multiple observations fit a reachable source path,
and **suspected** where attribution is missing.

| Item                                                                                                            | State; dates; releases/protocols                                                                    | Exact symptom                                                                                                                                                                                                                                                                                                                          | Mechanism and relevant code/commits                                                                                                                                                                                                                                                                                                                                                                                | Shipped status; unresolved #9749 relevance; scope boundary                                                                                                                                                                                                       |
| --------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [#9749](https://github.com/stablyai/orca/issues/9749)                                                           | Open; 2026-07-21; Windows 11; daemon-host 1.4.146→1.4.148; old v21/v22/v23 and current v24 observed | Three surviving daemons were greeted at `16:41:32.277Z`–`.286Z`; later bursts logged 55/30/65/60/60 v22 kills and 10/32 v23 kills, including repeated IDs, while 191,266 main-process spans showed no coincident app death. One v23 broad `shutdown reason:rpc killSessions:true` and repeated `shutdown-dispose-failed` were present. | **Supported composition, reporter causality not proven.** Versioned legacy adoption explains hellos; `cleanupDaemonForProtocol` explains broad shutdown; #8871's stale-mirror close echo best explains reconnect-time individual kills. `daemon-server.ts` logs `session-killed` before awaiting `host.kill`, so repeated records prove repeated requests, not repeated physical death.                            | No fix shipped for the destructive initiator. #9277 mitigates empty v24+ accumulation only. Skipping all legacy hello or killing legacy generations on sight would destroy the promised warm-reattach behavior and is unsafe scope creep.                        |
| [#9138](https://github.com/stablyai/orca/issues/9138)                                                           | Open; 2026-07-17; macOS 1.4.143/v22; observed v18/v20/v21/v22                                       | UI showed 8 sessions while about 46 Claude processes remained; removing stale trees removed about 370 processes and reduced swap from 25 GB to under 5 GB.                                                                                                                                                                             | **Proven accumulation, ownership policy deliberately conservative.** Normal disconnect, versioned endpoints, incomplete cross-profile ownership, sleeping/cold restore, and legacy wildcard claims prevent safe blind retirement. Prototype commit `7c915909b` implements an audit/journal/incarnation design but is unmerged.                                                                                     | No complete fix shipped. #9277 safely handles only empty current-generation v24+ daemons. The broader ownership journal, grace period, all-profile evidence, and enforcement rollout belong here, not the immediate #9749 close-authority patch.                 |
| [#9211](https://github.com/stablyai/orca/issues/9211)                                                           | Closed duplicate 2026-07-17; v21/v22                                                                | A v21 daemon remained four days beside v22, and each app launch greeted both.                                                                                                                                                                                                                                                          | **Proven intentional legacy discovery with missing retirement.** `createLegacyDaemonAdapters` plus `discoverLegacySessions`.                                                                                                                                                                                                                                                                                       | Consolidated into #9138; no separate shipped fix. Same accumulation input as #9749, but not its destructive initiator.                                                                                                                                           |
| [#9229](https://github.com/stablyai/orca/issues/9229)                                                           | Open P1; 2026-07-17; Linux headless                                                                 | Failed shutdown left a 15.55 GiB/81-process old runtime beside a 1.21 GiB/4-process replacement.                                                                                                                                                                                                                                       | **Supported reconciliation design.** Requires provenance, one destructive authority, exact daemon/session PID+start incarnations, complete evidence, and fail-closed missing reads.                                                                                                                                                                                                                                | Unshipped. Supplies invariants for later reconciliation. Implementing its full profile migration and journal in #9749 would be unsafe scope expansion.                                                                                                           |
| [#9195](https://github.com/stablyai/orca/issues/9195)                                                           | Open; 2026-07-17; Windows 1.4.144/v22; comments through #9277 release read                          | `orca-terminal-daemon.exe` remains after app exit; later comments observed v21/v22/v23 and invisible sessions.                                                                                                                                                                                                                         | **Proven intentional for non-empty daemons.** Normal quit calls `disconnectDaemon`, not `shutdownDaemon`; the child is detached/unref'd. Empty accumulation was an unhandled gap before #9277.                                                                                                                                                                                                                     | #9277 shipped in 1.4.147 for empty v24+ only. Treating every survivor as a bug would regress warm reattachment.                                                                                                                                                  |
| [PR #9277](https://github.com/stablyai/orca/pull/9277)                                                          | Merged 2026-07-20 as `7adda25b0`; first stable `v1.4.147`; v23→v24                                  | Empty current-generation daemons accumulated after clean app disconnect or failed adoption.                                                                                                                                                                                                                                            | **Proven by diff/tests.** Hello returns PID/start-time/launch-nonce identity; control/stream identity must match. `shutdownIfIdle` atomically checks one complete client, no unknown transport, no sessions, and no admission in flight. Shutdown fences admission before disposal. A two-minute watchdog covers only never-adopted startup.                                                                       | Shipped in `v1.4.147-rc.4`, `v1.4.147`, `v1.4.148-rc.1`, and `v1.4.148`. It explicitly does not perform startup reaping, retire legacy daemons, infer ownership, or kill reattachable PTYs. Strong identity/capability foundation; partial mitigation only.      |
| [#8871](https://github.com/stablyai/orca/issues/8871)                                                           | Open P0; 2026-07-15; first observed 1.4.141/v21; all corrections/comments read                      | First reconnect kill followed renderer bootstrap by 3.348 s. Three later fresh renderer processes correlated within about 1 s with bursts killing 4, 7, and 7 worktrees while app and daemon PIDs remained stable.                                                                                                                     | **Supported-to-proven request path.** Persisted remote handle → subscribe returns `no_connected_pty` → synthetic `pty-exit` → `closeTerminalTab(reason:'pty-exit')` → reason dropped from `session.tabs.close` → `closeMobileSessionTab` kills host PTY. Early pre-connect kills were correctly downgraded to unattributed. Close propagation intersects landed #8628 and later #8958.                             | Not fixed on main. This is the strongest immediate #9749 foundation. Trigger repair alone is insufficient; the authoritative host must adjudicate intent.                                                                                                        |
| [PR #8872](https://github.com/stablyai/orca/pull/8872)                                                          | Open; 2026-07-15; head `bb69fac775`; rebased 2026-07-21                                             | Prevents mirror `pty-exit`/cleanup evidence from killing a host PTY while retaining real user close and dead-tab retirement.                                                                                                                                                                                                           | **Actual diff/tests inspected.** Threads typed `user`/`pty-exit`/`cleanup`; host refuses non-user closes if any parent leaf has a connected PTY, republishes an unchanged snapshot with a guarded replay marker, and handles dead-leaf/live-sibling loops. Adds an optional daemon `kill intent:'auto'` guard, but intentionally sends no auto intent until protocol/capability negotiation exists.                | Unshipped. The earlier Windows/WSL live matrix passed on an older head and was explicitly invalidated by the rebase, so native validation must be rerun. This is the best narrow safety foundation, but reasonless old clients remain destructive on a new host. |
| [PR #8888](https://github.com/stablyai/orca/pull/8888)                                                          | Open; 2026-07-15; head `b13235211`; reviews/follow-ups read                                         | Ambiguous paired-runtime close RPCs could destroy host tabs with no requester attribution.                                                                                                                                                                                                                                             | **Actual diff/tests inspected.** Default-denies intent-less paired-runtime `session.tabs.close`, `terminal.close`, and `terminal.closeTab`; validates user source/target, dedupes request IDs per device across reconnects, rate-limits, restricts create rollback to its connection, and traces device/connection/source/decision without bearer tokens. Adds local daemon-control client ID to `session-killed`. | Unshipped. Useful defense-in-depth and logging foundation. Its “old paired client gets successful no-op” behavior is safely conservative but needs explicit compatibility/product acceptance; taking the entire policy is broader than the smallest #9749 fix.   |
| [#9414](https://github.com/stablyai/orca/issues/9414)                                                           | Open tracking issue; 2026-07-19                                                                     | Recognition-dependent terminal lifecycle actions can destroy or strand arbitrary processes.                                                                                                                                                                                                                                            | **Proven design boundary.** Host owns adjudication; stale client transport state and agent-name recognition are not kill authority. Tracks #8872/#8888 and lifecycle-state work.                                                                                                                                                                                                                                   | Unshipped tracker. Aligns with #9749 invariants; generic agent recognition work is separate scope.                                                                                                                                                               |
| [PR #8628](https://github.com/stablyai/orca/pull/8628)                                                          | Merged 2026-07-14 as `36cd8a334`; releases after that date                                          | Tab close did not durably retire all associated terminal/session state.                                                                                                                                                                                                                                                                | **Actual merge diff inspected.** Centralized terminal retirement/ownership and ensured remote-owned closes reach the authoritative host. The remote call still carried no close reason, so lifecycle and user closes were indistinguishable.                                                                                                                                                                       | Shipped and important context, not a regression to revert wholesale. #9749 must preserve its durable explicit-user close while adding authority.                                                                                                                 |
| [#8878](https://github.com/stablyai/orca/issues/8878) / [PR #9098](https://github.com/stablyai/orca/pull/9098)  | Issue and PR open; 2026-07-15/17; PR head `9f3abd778`                                               | A reconnecting paired client resumes a provider session still live on the host, producing duplicate TUIs.                                                                                                                                                                                                                              | **Proven companion feedback loop.** Client-local resume runs before authoritative mirror arrival; a #8871 kill also leaves a resume record. PR gates resume for runtime-owned worktrees while preserving the record.                                                                                                                                                                                               | Unshipped. Relevant reconnect stress case, but provider-session resume dedupe is not needed to stop #9749 kills.                                                                                                                                                 |
| [#9352](https://github.com/stablyai/orca/issues/9352) / [#9585](https://github.com/stablyai/orca/issues/9585)   | Open; 2026-07-18/20; remote macOS and Windows                                                       | Closed or killed remote tabs return as `ptyId:null` phantoms; host snapshots keep dead terminal surfaces, and repeated host restarts accumulate them.                                                                                                                                                                                  | **Proven stale mirror/snapshot state.** Host `touchMobileSessionSnapshotsForPty` republishes the same tab; viewer mirrors every terminal surface. Remote transport also leaks the explicit-kill error.                                                                                                                                                                                                             | Unshipped. Explains repeated stale close inputs and must be in stress coverage, but pruning dead surfaces is a separate lifecycle fix requiring sleeping-session care.                                                                                           |
| [#9217](https://github.com/stablyai/orca/issues/9217) / [#8970](https://github.com/stablyai/orca/issues/8970)   | #9217 closed duplicate 2026-07-19; #8970 open; v1.4.143                                             | Agent/sidebar rows remain after local close or SSH relay connection loss.                                                                                                                                                                                                                                                              | **Proven UI/status lifecycle gaps.** SSH teardown intentionally preserves PTY ownership for reattach but omitted status clearing; renderer lacks a sweep.                                                                                                                                                                                                                                                          | Separate non-destructive roster cleanup. Combining sidebar cleanup with #9749 would be scope creep.                                                                                                                                                              |
| [#8851](https://github.com/stablyai/orca/issues/8851) / [PR #8825](https://github.com/stablyai/orca/pull/8825)  | Issue closed; PR merged 2026-07-15 as `c8986ca52`; 1.4.143 notes                                    | Finished named Claude children remained as idle sidebar rows.                                                                                                                                                                                                                                                                          | **Proven Claude roster mechanism, not PTY lifecycle.** Working-only roster and hydration cleanup.                                                                                                                                                                                                                                                                                                                  | Shipped, but #8970 proves top-level/session residuals. Unrelated to destructive daemon authority.                                                                                                                                                                |
| [#8275](https://github.com/stablyai/orca/issues/8275) / [#8276](https://github.com/stablyai/orca/issues/8276)   | #8275 open `cannot_repro`; #8276 closed duplicate; 2026-07-11; v20→v22 attempts                     | Rapid worktree removal was followed by daemon death and unrelated split panes exiting `-1`; no shutdown record.                                                                                                                                                                                                                        | **Different mechanism.** Shared daemon process dies during PTY teardown; current v22 attempt did not reproduce.                                                                                                                                                                                                                                                                                                    | Not the #9749 initiator: #9749 daemons stay alive and log explicit shutdown/kill requests. Keep daemon-death regression coverage, but do not merge root causes.                                                                                                  |
| [PR #8140](https://github.com/stablyai/orca/pull/8140)                                                          | Merged 2026-07-10 as `03a673708`/PR head `1710325e0`; fixes #8048                                   | Graceful then immediate Windows PTY teardown double-closed the same ConPTY handle and killed the shared daemon.                                                                                                                                                                                                                        | **Proven by actual native harness/diff.** `nodePtyKillIssued` makes later Windows force a no-op. Harness uses unique pipe/temp state, 25 victims, and a witness PTY/daemon survival assertion.                                                                                                                                                                                                                     | Shipped. Prevents one daemon-death path; does not authorize reconnect closes and does not retire descendants. Reuse its isolation/witness patterns only.                                                                                                         |
| [PR #8284](https://github.com/stablyai/orca/pull/8284)                                                          | Closed unmerged 2026-07-16; head `ebe0b6523`                                                        | Proposed serial worktree PTY admission and verified fail-closed teardown across Windows/POSIX/SSH.                                                                                                                                                                                                                                     | **Actual 50-file diff/tests inspected.** Retained shutdown ownership, admission fences, physical-exit proof, and Windows relay ConPTY ownership.                                                                                                                                                                                                                                                                   | Contrary to the issue prompt, it did **not** merge. Landed work was split/superseded by #8661 and #8706. Its teardown patterns are useful, but adopting its broad branch is unsafe.                                                                              |
| [PR #8661](https://github.com/stablyai/orca/pull/8661)                                                          | Merged before 1.4.146; key commit `a635ff9a7`                                                       | Disposal failure could prevent orderly runtime/daemon termination.                                                                                                                                                                                                                                                                     | **Proven current source behavior.** Shutdown RPC catches `host.dispose`, logs `shutdown-dispose-failed`, then continues fencing, client destruction, and server close; resource disposal is retried.                                                                                                                                                                                                               | Shipped before #9749. Corrects the report's inference that the failure necessarily leaves the endpoint authoritative forever. A native handle may still keep a process alive, but the server intends to close.                                                   |
| [#9045](https://github.com/stablyai/orca/issues/9045)                                                           | Open; 2026-07-16; Windows                                                                           | Worktree deletion fails because agent descendants retain filesystem handles after PTY teardown.                                                                                                                                                                                                                                        | **Supported descendant ownership gap.** Root PTY exit is not full tree exit on Windows.                                                                                                                                                                                                                                                                                                                            | Unresolved. It concerns cleanup after a legitimate kill, not who may initiate it.                                                                                                                                                                                |
| [#9704](https://github.com/stablyai/orca/issues/9704)                                                           | Open; 2026-07-21; Windows 1.4.147/v24                                                               | Killed PTY descendants survive (six trees/18 processes/~1.1 GB, later ~2 GB); runtime lists dead sessions as connected.                                                                                                                                                                                                                | **Proven descendant leakage plus stale registry.** Explicitly asks for initiator attribution rather than assuming the kill was valid.                                                                                                                                                                                                                                                                              | Unresolved. Different from #9749 because the root session was killed; #9704 concerns what survives afterward.                                                                                                                                                    |
| [PR #9752](https://github.com/stablyai/orca/pull/9752)                                                          | Open; 2026-07-21; head `6be947317`                                                                  | Windows agent descendants survive explicit or natural PTY-root exit.                                                                                                                                                                                                                                                                   | **Actual native patch and tests inspected.** Suspends recognized native-Windows agent ConPTY roots, creates/configures/assigns a kill-on-close Job Object before resume, owns the handle atomically, and falls back to direct-root termination. Plain terminals, WSL, POSIX, SSH relay, and unrelated sessions are excluded; Windows process-table commands are removed.                                           | Unshipped. Correct post-authorization cleanup, explicitly not an initiator fix. Combining it into the #9749 authority patch would obscure causality; compose/test separately if it lands first.                                                                  |
| [PR #9266](https://github.com/stablyai/orca/pull/9266) / [PR #9612](https://github.com/stablyai/orca/pull/9612) | Both open; 2026-07-18/20                                                                            | Alternative Windows descendant tree termination using process enumeration/taskkill-style sweeps.                                                                                                                                                                                                                                       | **Competing cleanup approaches.** Carry PID-reuse, access-denied, cost, and partial-tree risks that native Job ownership avoids.                                                                                                                                                                                                                                                                                   | Unshipped. Do not duplicate inside #9749.                                                                                                                                                                                                                        |
| [PR #8706](https://github.com/stablyai/orca/pull/8706)                                                          | Merged 2026-07-15 as `40d015992`/merge `6dbeeda3e`; stable thereafter                               | POSIX agent descendants survived root teardown.                                                                                                                                                                                                                                                                                        | **Proven POSIX snapshot-before-root-kill.** Windows intentionally returns no snapshot.                                                                                                                                                                                                                                                                                                                             | Shipped for macOS/Linux only. No #9749 authority effect.                                                                                                                                                                                                         |
| [#9193](https://github.com/stablyai/orca/issues/9193) / [PR #9288](https://github.com/stablyai/orca/pull/9288)  | Both open; 2026-07-17/18                                                                            | `terminal close --tab` cannot address live floating/tabless PTYs; pane close can kill, and Windows may retain a stale entry.                                                                                                                                                                                                           | **Proven addressing/registry gap.** PR routes tabless PTY through existing pane close.                                                                                                                                                                                                                                                                                                                             | Unshipped. Diagnostic and stale-registry relevance only; making more sessions closeable is not authority fencing.                                                                                                                                                |
| [#9563](https://github.com/stablyai/orca/issues/9563) / [PR #9634](https://github.com/stablyai/orca/pull/9634)  | Both open; 2026-07-20/21; headless macOS                                                            | LaunchAgent host invokes update, disconnects clients, old binary respawns, and ShipIt reports “App Still Running.”                                                                                                                                                                                                                     | **Supported updater/headless ownership race.** PR defers installation while serving headlessly.                                                                                                                                                                                                                                                                                                                    | Unshipped. Must be a relaunch scenario in the harness, but updater policy is separate from close authority.                                                                                                                                                      |
| [#8261](https://github.com/stablyai/orca/issues/8261)                                                           | Open; 2026-07-11; macOS/Linux headless comments                                                     | Silent update installation kills active PTYs; one headless log has `shutdown reason:rpc killSessions:true`.                                                                                                                                                                                                                            | **Supported broad shutdown during update.**                                                                                                                                                                                                                                                                                                                                                                        | Unresolved adjacent caller/lifecycle context. Updater UX and install policy are scope creep; broad shutdown attribution is relevant.                                                                                                                             |
| [#8459](https://github.com/stablyai/orca/issues/8459)                                                           | Open; 2026-07-13                                                                                    | Resource Manager labels live daemon sessions orphan from renderer-only evidence and bulk-kills them.                                                                                                                                                                                                                                   | **Proven ownership-safety precedent.** Absence from one renderer is not authority.                                                                                                                                                                                                                                                                                                                                 | Unshipped. Same invariant as #9749, different UI initiator. Do not couple UI resource-manager redesign.                                                                                                                                                          |
| [#8585](https://github.com/stablyai/orca/issues/8585)                                                           | Open; 2026-07-13; SSH relay                                                                         | Failed relay `--connect` unlinks a socket while the old relay and PTYs remain alive.                                                                                                                                                                                                                                                   | **Different namespace/transport ownership leak.**                                                                                                                                                                                                                                                                                                                                                                  | Unresolved. SSH regression consideration, not a native daemon-generation fix.                                                                                                                                                                                    |
| [#7783](https://github.com/stablyai/orca/issues/7783)                                                           | Open; 2026-07-08; macOS                                                                             | Helper survives app quit with roughly 189 descendants.                                                                                                                                                                                                                                                                                 | **Supported historical survival/descendant leak.**                                                                                                                                                                                                                                                                                                                                                                 | Unresolved adjacent accumulation evidence; no reconnect-kill attribution.                                                                                                                                                                                        |
| [#8457](https://github.com/stablyai/orca/issues/8457)                                                           | Open; 2026-07-13                                                                                    | Headless serve and GUI relaunch ownership collide, interrupting or duplicating live agents.                                                                                                                                                                                                                                            | **Supported multi-owner lifecycle conflict.**                                                                                                                                                                                                                                                                                                                                                                      | Reinforces exactly-one reconciliation authority. Full headless lifecycle redesign is separate.                                                                                                                                                                   |
| [#8362](https://github.com/stablyai/orca/issues/8362)                                                           | Open; 2026-07-12; remote relay                                                                      | PTY master FDs leak across relay children.                                                                                                                                                                                                                                                                                             | **Different mechanism: missing close-on-exec/inherited descriptors.**                                                                                                                                                                                                                                                                                                                                              | Unresolved, but unrelated to named-pipe discovery or destructive requests.                                                                                                                                                                                       |
| [#9569](https://github.com/stablyai/orca/issues/9569) / [PR #9587](https://github.com/stablyai/orca/pull/9587)  | Issue closed 2026-07-20; PR open                                                                    | Worktree removal dials a dead legacy v22 socket after v23 upgrade and fails ENOENT.                                                                                                                                                                                                                                                    | **Proven stale adapter routing.** PR tolerates dead legacy adapter teardown.                                                                                                                                                                                                                                                                                                                                       | Unshipped. Demonstrates adapter lifecycle staleness; no authority fix.                                                                                                                                                                                           |
| [#8689](https://github.com/stablyai/orca/issues/8689) / [PR #8697](https://github.com/stablyai/orca/pull/8697)  | Closed/merged 2026-07-14; merge `840d3277d`                                                         | Daemon accepts a connection but never answers hello, wedging startup.                                                                                                                                                                                                                                                                  | **Proven bounded handshake/replacement path.**                                                                                                                                                                                                                                                                                                                                                                     | Shipped. Harness must bound hello and avoid reconnect storms; not a session-kill mechanism.                                                                                                                                                                      |
| [PR #7538](https://github.com/stablyai/orca/pull/7538)                                                          | Merged 2026-07-07 as `03cfc5bd1`                                                                    | Windows update moved daemon code while live daemon/PTYs should survive.                                                                                                                                                                                                                                                                | **Proven historical compatibility intent.** Relocated host preserves same-protocol daemon across update.                                                                                                                                                                                                                                                                                                           | Shipped. Later legacy adapters extended preservation across protocol bumps; blanket reaping would regress this contract.                                                                                                                                         |
| [PR #2974](https://github.com/stablyai/orca/pull/2974)                                                          | Merged 2026-05-28 as `5a852415a`                                                                    | Resolver refresh risked killing live PTYs.                                                                                                                                                                                                                                                                                             | **Proven preserve-live policy.** Protocol bump/legacy routing is preferred to broad cleanup.                                                                                                                                                                                                                                                                                                                       | Shipped. Strong evidence against “kill old generation on sight.”                                                                                                                                                                                                 |
| [PR #7836](https://github.com/stablyai/orca/pull/7836)                                                          | Merged 2026-07-18 as `5f6728c1b`                                                                    | Shutdown/provider selection race could clear a binding while the daemon PTY survived.                                                                                                                                                                                                                                                  | **Proven ownership race fix.** Retains provider/shutdown ownership until outcome.                                                                                                                                                                                                                                                                                                                                  | Shipped. Preserve in regression tests; not close-intent adjudication.                                                                                                                                                                                            |
| [PR #1343](https://github.com/stablyai/orca/pull/1343)                                                          | Merged 2026-05-03 as `df1fefcc2`                                                                    | Users lacked session visibility; stale PID files risked PID-reuse mistakes.                                                                                                                                                                                                                                                            | **Proven management/PID-start-time guard.**                                                                                                                                                                                                                                                                                                                                                                        | Shipped. Useful diagnostic/incarnation precedent, but observability alone cannot prevent #9749.                                                                                                                                                                  |
| [PR #9516](https://github.com/stablyai/orca/pull/9516)                                                          | Merged 2026-07-20 as `2e67af82d`/`de86f482c`                                                        | Windows worktree teardown RPCs could hang indefinitely.                                                                                                                                                                                                                                                                                | **Proven bounded-deadline change.**                                                                                                                                                                                                                                                                                                                                                                                | Shipped. Bounds cleanup but does not decide whether cleanup is authorized.                                                                                                                                                                                       |
| [PR #8768](https://github.com/stablyai/orca/pull/8768) / [PR #8817](https://github.com/stablyai/orca/pull/8817) | Merged 2026-07-14/15 as `02de3c565` and `f7926c11f`                                                 | Restored/legacy PTYs could render blank or be unmounted while still live.                                                                                                                                                                                                                                                              | **Proven adoption compatibility.** Keep legacy daemon PTYs mounted and defer snapshots correctly.                                                                                                                                                                                                                                                                                                                  | Shipped. Direct reason that refusing all legacy discovery is unsafe.                                                                                                                                                                                             |
| [#9441](https://github.com/stablyai/orca/issues/9441) / [PR #9446](https://github.com/stablyai/orca/pull/9446)  | Open; 2026-07-19; macOS 1.4.146                                                                     | Large persisted profile drives high CPU/RSS and exits during startup restoration; clean user-data does not reproduce.                                                                                                                                                                                                                  | **Supported restore-load ordering issue.** PR defers full worktree scan.                                                                                                                                                                                                                                                                                                                                           | Unshipped. Profile-switch/load stress case only; not destructive daemon authority.                                                                                                                                                                               |

## Timestamped incident and call-flow reconstruction

### A. How generations survive

1. **2026-07-15 13:50 local:** #9749's v21 daemon starts.
2. An app quit/update runs `disconnectDaemon`, whose adapter `disconnectOnly`
   closes client sockets and leaves live PTYs/history reattachable. The daemon is
   detached/unref'd, so parent death is not daemon death.
3. **2026-07-18 14:26 local:** a v22 daemon starts on a different versioned
   endpoint while v21 retains its PTYs.
4. **2026-07-20 14:50 local:** v23 starts while both prior endpoints remain.
5. Windows endpoints are generated by
   `getDaemonSocketPath(runtimeDir, protocolVersion)` as
   `\\?\pipe\orca-terminal-host-v<protocol>-<sha256(runtimeDir)[0..12]>`.
   Tokens and PID records are likewise protocol-specific files. No endpoint
   collision forces an old generation out.
6. Before protocol 24, a non-empty daemon had no generation-retirement
   protocol. Since #9277, an empty v24+ daemon can atomically self-retire, but a
   live session intentionally blocks it and v23-or-older behavior is unchanged.
7. #9749's claim that `shutdown-dispose-failed` necessarily leaves the pipe open
   is not source-proven for 1.4.146. Commit `a635ff9a7` catches disposal failure
   and continues ordinary shutdown; #9277 additionally closes admission first.
   A stuck native handle may keep a process alive, but the endpoint is meant to
   stop being authoritative.

### B. Why startup greets every surviving generation

1. Current startup establishes the v25 (v24 in the reporter build) adapter and
   its complete control/stream lifecycle lease.
2. `createLegacyDaemonAdapters(runtimeDir)` loops every value in
   `PREVIOUS_DAEMON_PROTOCOL_VERSIONS`, derives that version's pipe/token/PID
   paths, and probes each endpoint.
3. A responsive endpoint receives a `DaemonPtyAdapter` configured with that
   exact old protocol. It has no respawn callback, because new code must not
   recreate old environment semantics.
4. `DaemonPtyRouter.discoverLegacySessions()` calls `adapter.listProcesses()`
   for each legacy adapter.
5. `listProcesses()` calls `ensureConnected()`. `DaemonClient.doConnect()` opens
   a control socket, sends hello, then opens a stream socket and sends hello
   using one client UUID. This is the precise source of each control/stream pair
   in #9749 at `16:41:32.277Z` through `.286Z`.
6. v24+ hellos return PID/start-time/launch-nonce and require both sockets to
   match. Old protocols return no identity, so successful token+protocol hello
   authenticates the endpoint but cannot prove a process incarnation.
7. `listSessions` results populate `sessionAdapters: Map<sessionId, adapter>`.
   That map is keyed only by reusable session ID, not daemon/session
   incarnation; a later generation can overwrite an earlier claim.
8. No code in hello acceptance, adapter construction, or discovery sends
   `kill`, `shutdown`, or `shutdownIfIdle` to a legacy daemon.

### C. Exact broad shutdown caller

1. Current-daemon replacement/manual restart/full cleanup calls
   `cleanupDaemonForProtocol(runtimeDir, PROTOCOL_VERSION)` (or the explicitly
   supplied current handle protocol).
2. It probes that version's endpoint and creates a `DaemonClient` for the same
   protocol.
3. It connects with the same control/stream hello sequence.
4. It requests `listSessions`; any error is converted to `{ sessions: [] }`.
5. It then unconditionally sends `shutdown { killSessions: true }` and treats a
   reply race with daemon exit as success.
6. `daemon-server.ts` logs `shutdown reason:'rpc' killSessions:true`, begins the
   ordinary shutdown admission fence, awaits `host.dispose`, logs but catches
   `shutdown-dispose-failed`, writes the reply if possible, disposes resources,
   destroys clients/transports, unlinks owned identity artifacts, and closes
   the server.
7. Repository search found no other direct production sender of
   `shutdown { killSessions: true }`. Legacy adapter discovery is not a caller.
8. Unsafe residual: list failure cannot be treated as proof of emptiness for
   any future generation reaper, and broad shutdown still lacks an origin,
   daemon-incarnation, ownership, and intent audit record.

### D. Supported reconnect-to-mass-kill path

1. **Renderer bootstrap T+0:** a paired desktop/runtime renderer hydrates
   persisted mirrors containing process-lifetime remote terminal handles.
2. **T+milliseconds:** before the fresh authoritative session snapshot fully
   reconciles, remote transport subscribes using a stale handle.
3. The host cannot resolve a connected PTY for that handle and returns a gone
   condition; remote transport synthesizes `pty-exit`.
4. `Terminal.tsx` calls `closeTerminalTab(tabId, { reason: 'pty-exit' })`.
5. Current main uses that reason for local retirement behavior but
   `closeWebRuntimeSessionTab` sends only `{ worktree, tabId }`.
6. Runtime RPC `session.tabs.close` has no origin/intent in its schema or
   handler. `OrcaRuntimeService.closeMobileSessionTab` treats it like an
   explicit user request and invokes either direct `ptyController.kill`, a
   whole-parent renderer close, or headless teardown.
7. For daemon-backed terminals, the PTY controller is the `DaemonPtyRouter`.
   `adapterFor(sessionId)` uses the discovery map to select a current or legacy
   generation and its adapter sends `kill { sessionId, immediate }`.
8. The owning daemon logs `session-killed` before awaiting `host.kill`. This is
   why app and daemon PIDs remain alive while real terminal sessions disappear.
9. **#8871 observed T+3.348 s** for the first bootstrap-to-kill incident. Three
   other new renderer processes aligned within about one second with 4-, 7-,
   and 7-worktree kill bursts.
10. Stale host tab surfaces (#9352/#9585), persisted client mirrors, reconnect
    retries, and republished snapshots can invoke the same close again. If the
    daemon still retains the session entry or physical exit is unresolved, a
    reconnect can rediscover and target the same ID again. Because logging
    precedes the awaited kill, repeated `session-killed` records can also be
    repeated failed/not-yet-settled attempts; they do not prove a dead process
    was resurrected and killed twice.

### E. Why adjacent bugs are different

- **#8275/#8048/#8140:** PTY teardown double-closes a Windows ConPTY native
  handle and the shared daemon dies. There is no broad shutdown event. All
  sessions disappear because their owner process died.
- **#9704/#9045/#9752:** a valid or invalid kill has already targeted the PTY
  root, but Windows descendants remain and retain memory/files. The owner stays
  alive or the registry stays stale. This is cleanup completeness after a kill,
  not destructive authority.
- **#9749/#8871:** app and daemons remain alive. Explicit RPCs reach live daemon
  sessions because stale client lifecycle evidence is interpreted as intent.

## Compatibility behavior that must remain

- App quit is a disconnect, not terminal shutdown.
- Same-protocol daemon survival across packaged Windows updates (#7538) avoids
  terminating live work.
- Old-protocol adapters remain addressable after an upgrade so mounted and
  sleeping PTYs can reattach (#2974, #8768, #8817).
- Legacy daemons cannot be judged empty from one current profile or renderer.
  Missing ownership data, inactive profiles, sleeping sessions, remote/SSH
  routes, and legacy claims all mean keep/audit.
- Current protocol 24+ can retire only after its own atomic server-side idle
  predicate proves there is nothing to preserve.
- Older clients/servers must not infer support from an ignored additive field.
  In particular, no caller may send daemon `kill intent:'auto'` until a
  protocol bump or negotiated capability proves the daemon will enforce it.

## Direction comparison

| Direction                                   | Immediate safety                                                                                                                                          | Compatibility and failure mode                                                                                                                                                           | Decision                                                                           |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Skip `client-hello` for every old protocol  | Avoids routing kills to legacy sessions, but also makes their live PTYs invisible/unattachable.                                                           | Directly violates warm legacy reattachment and converts preservation into inaccessible leaks.                                                                                            | Reject. Hello is not the authority bug.                                            |
| Force-exit on `shutdown-dispose-failed`     | Bounds a half-shutdown process if endpoint fencing and handle cleanup are correct.                                                                        | Can silently destroy promised live PTYs; does not stop reconnect close RPCs; overlaps #9752 descendant semantics. Current source already continues server shutdown after disposal error. | Not the immediate fix. Test bounded endpoint loss separately.                      |
| Startup reaping                             | Can reduce accumulated attack surface.                                                                                                                    | Unsafe without #9138/#9229 all-profile evidence, exact incarnations, grace observations, barriers, and one authority.                                                                    | Audit-only follow-up, not #9749 patch.                                             |
| Explicit generation handoff/retirement      | Correct long-term lifecycle model.                                                                                                                        | Requires old/new capability negotiation and ownership persistence across profiles, SSH, WSL, and sleeping sessions.                                                                      | Broader #9138/#9229 work.                                                          |
| Daemon-side fencing                         | Prevents a retiring daemon from accepting new work or acting after retirement begins.                                                                     | v24 #9277 already fences ordinary/idle shutdown admission; older protocols cannot be retrofitted.                                                                                        | Preserve and extend only with negotiated capability.                               |
| Host close-intent adjudication (#8872)      | Stops the demonstrated stale `pty-exit` echo at the component that owns the live PTY, while real user close and genuinely dead tab retirement still work. | Old clients remain ambiguous unless paired with a default-deny compatibility policy.                                                                                                     | Best narrow foundation.                                                            |
| Connection/device provenance policy (#8888) | Default-denies ambiguous paired-runtime destruction, adds dedupe/rate bounds and strong attribution.                                                      | Older paired clients receive a safe successful no-op; policy is broader than one close reason and must preserve mobile/CLI/local/SSH semantics.                                          | Reuse focused policy/logging pieces; assess full policy after the failing harness. |
| Job Objects (#9752)                         | Reaps descendants after an authorized native-Windows agent PTY kill.                                                                                      | Cannot determine intent; plain terminal and WSL exclusions are semantically important.                                                                                                   | Compose separately, never substitute for authority.                                |

The smallest robust immediate change is expected to combine typed close intent
with host-side liveness adjudication and non-secret requester logging. The
three-generation harness must decide whether #8888's default-deny/dedupe layer
is also required for old-client and repeated-reconnect safety. Full generation
retirement stays in #9138/#9229.

## Harness gate for the next phase

The first executable artifact will be an isolated native-Windows harness, not a
production edit. It must:

- allocate a temporary runtime/user-data root and unique pipe namespace;
- launch three disposable protocol fixtures (for example v21/v22/v23) with
  distinct live canary children plus stale/terminating table entries;
- use the real `DaemonClient`, legacy adapter discovery, router, and runtime
  session-close path where feasible instead of calling a proposed helper;
- prove hello/discovery alone is non-destructive;
- separately trigger the exact broad current-protocol shutdown caller and the
  reconnect stale-mirror close path;
- distinguish daemon/app liveness, PTY-root liveness, and descendant liveness
  with independent counters and process handles;
- repeat reconnect bursts and record duplicate requests for a retained ID;
- model a PTY owner whose disposal never proves physical exit and assert a
  bounded, non-authoritative endpoint state;
- cover current→next protocol upgrade, same-version quit/relaunch, profile
  switch, remote-server paired client, multiple simultaneous clients, mixed
  client/server versions, and WSL/SSH routing boundaries;
- validate PID/start identity, dead parent, access-denied identity probes, no
  listener/pipe/handle leaks, and no CIM/PowerShell per-session hot path;
- guarantee cleanup in `finally` using only fixture-owned exact PIDs, handles,
  files, and pipe names.

Externally visible RED invariants are: reconnect kills one or more canary PTYs
while the app/fixture processes remain alive; repeated stale input can issue
another destructive request for the same retained incarnation; and a refused
disposal does not reach a bounded terminal endpoint state. The post-fix GREEN
invariants are survival of every unrelated canary, one exact kill for an
explicit user target, legacy warm reattachment, bounded retirement fencing, and
zero leaked fixture processes/handles/pipes.

## Implemented immediate safety boundary

Implementation snapshot: 2026-07-21 15:26 PDT (2026-07-21 22:26 UTC).

The initial implementation used a 30-second capability cache keyed only by
runtime-environment ID. That was rejected before finalization: a positive
`status.get` result could outlive a server replacement under the same
environment, and the later destructive request had no proof that it reached the
generation that supplied the capability.

The implemented boundary makes compatibility and identity validation atomic
with the lifecycle request:

1. Explicit user closes remain on `session.tabs.close`, preserving the durable
   host-owned close behavior shipped by #8628 and compatibility with old
   servers that ignore the additive `reason:'user'` field.
2. Renderer-originated `pty-exit` and `cleanup` echoes use the additive
   `session.tabs.closeLifecycle` method. An old server returns
   `method_not_found` before entering its legacy destructive close handler. The
   client clears optimistic close suppression and requests an authoritative
   snapshot; it never falls back to `session.tabs.close`.
3. The lifecycle method requires both the `publicationEpoch` observed in the
   host snapshot and the exact terminal handle observed for that tab. Missing
   evidence means keep, refresh, and audit rather than kill.
4. The host refreshes its PTY records, rejects a different publication epoch,
   rejects a terminal handle that no longer belongs to the addressed parent,
   rejects when provider liveness is unavailable, and rejects while any parent
   leaf still has a connected PTY. Refusals carry a bounded reason
   (`stale-publication`, `stale-terminal`, `unknown-liveness`,
   `live-host-pty`, or `retirement-owner`) and republish only when doing so
   cannot create the known dead-leaf/live-sibling echo loop.
5. A lifecycle close never signals a PTY or relays a renderer close. A dead
   whole headless parent can be retired from persisted/runtime state with
   `killPtys:false`; a renderer-owned parent or partial split remains with its
   authoritative owner. Thus a reusable tab ID or incomplete provider read
   cannot become destructive authority.
6. Reasonless closes from authenticated legacy mobile or runtime clients retain
   their pre-change explicit-user meaning, so upgrading only the host does not
   break close. Their old lifecycle/user ambiguity remains until the client
   upgrades; unattributed in-process reasonless calls are refused and replayed.
7. Renderer close intents are scoped by runtime environment and worktree, and
   terminal-incarnation evidence must match that exact runtime environment.
   Identical tab/worktree IDs in another profile cannot suppress or authorize
   this profile's retirement.

The RPC span records origin/client kind, close reason, connection ID, request
ID, publication epoch, and allow/refusal decision. It does not record terminal
contents, authentication tokens, or environment secrets. The legacy adapter
hello/discovery path, warm PTY adoption, daemon shutdown protocol, and Job
Object descendant cleanup remain unchanged.

This is the smallest immediate #9749 fix. Cross-profile generation inventory,
all-profile ownership evidence, sleeping-session policy, and explicit daemon
handoff/retirement remain #9138/#9229. Windows descendant reaping after an
authorized kill remains #9704/#9752.

## GREEN evidence

The post-fix native-Windows run completed at 2026-07-21 15:25 PDT:

- v21/v22/v23 used distinct versioned named pipes under a disposable runtime
  root, with six independent PTY-root/descendant canaries;
- three reconnect discovery bursts plus simultaneous clients opened the real
  control/stream hello pairs without destructive side effects;
- desktop and two remote/profile connection identities attempted each stale
  mirror retirement three times, then a full reconnect-client process
  exit/relaunch repeated the same persisted IDs for six attempts total;
- the lifecycle requests traversed the production schema, dispatcher,
  `OrcaRuntimeService`, and `DaemonPtyRouter` using publication/terminal
  incarnation claims;
- every daemon, PTY root, and descendant remained alive while the app/client
  process remained alive;
- the contained refusal-to-exit PTY produced `shutdown-dispose-failed`, lost
  named-pipe authority within the bounded deadline, and was cleaned by exact
  fixture-owned process identity;
- the reconnect/relaunch test passed in 42.9 seconds and the bounded-disposal
  test passed in 15.2 seconds.

Focused verification at this checkpoint: node and web typechecks passed;
changed-file `oxlint` and `git diff --check` passed; 181 focused renderer/RPC
tests passed; and 12 host close-adjudication tests passed (784 unrelated tests
filtered out). No PowerShell/CIM process-per-session path, polling loop, broad
installed-daemon discovery, or Job Object implementation was added.

Additional validation completed at 2026-07-21 15:48 PDT:

- the native generation harness passed 25 reconnect bursts in 52.1 seconds;
  every v21/v22/v23 daemon and all six PTY-root/descendant canaries survived;
- the mixed-version daemon-lifecycle E2E kept the non-empty v22 daemon
  reattachable while the empty current v24 daemon retired through #9277;
- a fresh `pnpm build:electron-vite` and a fresh paired-web-client build both
  completed successfully;
- 182 remote-runtime, multi-client, remote-server parity, SSH-provider, WSL
  host-context, and remote PTY transport tests passed;
- the complete runtime service/RPC group passed 884 of 885 tests. The lone
  failure, `preserves existing badgeColor on runtime createRepo dedupe`, is an
  existing Windows-only POSIX path expectation (`/tmp/...` versus
  `\\tmp\\...`) in code untouched by this change; every close, remote, SSH,
  and WSL case in that run passed;
- CLI typecheck, switch-independent changed-file lint, reliability gates,
  max-lines ratchet, and `git diff --check` passed. The repository-wide
  switch-exhaustiveness command is blocked by the pre-existing unmatched
  `undefined | 'current' | 'duplicate'` cases in
  `skill-freshness-group.tsx`, outside this diff.

Two practical Electron runs exposed setup/teardown limitations without
contradicting the close-safety result:

- `restart-restore-terminal-input.spec.ts` completed the clean-restart, live
  daemon, restored-output, keyboard-input, and direct-input assertions, then
  failed only in `RestartSession.dispose()` with `EPERM` deleting its isolated
  profile. Restart Manager and Sysinternals Handle found no surviving file
  lock after teardown; the exact fixture root deleted successfully later
  without terminating a process. The same failure reproduced with the temp
  root inside this worktree and with the production diff to
  `orca-restart.ts` empty, so it is recorded as a fixture cleanup limitation,
  not a session-liveness failure;
- the paired-browser navigation E2E built the web client and launched the
  isolated desktop, but timed out before pairing because its host fixture
  displayed `No workspaces found`. The deterministic multi-client runtime
  integration passed; no terminal-close assertion failed in this E2E.

All diagnostic downloads and worktree-local E2E temp roots were removed by
their exact verified paths. No installed Orca daemon pipe or real user terminal
was discovered, greeted, stopped, or mutated during these runs.

## Internal review-until-clean and final native evidence

The requested `$internal-review-until-clean` loop ran against merge base
`937a2015eaf85144d02848c5b6d4c09ecd423830`. Round 1 found and fixed four
in-scope safety defects:

- lifecycle retirement could still relay a destructive renderer close or kill
  retained/disconnected headless IDs; lifecycle requests now never signal a
  process and only state-retire a dead whole headless parent;
- an unavailable/access-denied PTY inventory was treated like authoritative
  absence; it now returns `unknown-liveness` and keeps/audits;
- pending close intent was keyed only by worktree and could cross-contaminate
  two runtime profiles; it is now scoped and cleaned by environment/worktree;
- the harness accepted a two-second PID start-time tolerance; capture and
  revalidation now compare the same CIM `CreationDate` exactly.

The elegance pass also removed an unnecessary cached capability probe. The
additive method dispatch on the exact connection is the atomic compatibility
boundary; a cached positive result could outlive server replacement. The
performance pass found no production polling, process enumeration, listener,
or subprocess addition. The existing bounded controller inventory refresh is
unchanged in frequency, snapshot refreshes coalesce per environment/worktree,
and all added tracking maps have completion or ownership cleanup. Round 2
re-interrogated the full diff and found no remaining proven in-scope issue.
After strengthening the native harness to invoke production desktop discovery,
round 3 found one Windows-only test defect: three scanner tests modeled a live
v9 endpoint through POSIX `existsSync` but let every Windows named-pipe probe
connect. Their socket mock now accepts only v9 and errors every other version;
all 133 daemon lifecycle tests pass. The subsequent full-diff review is clean.

The latest native Windows run captured its event reconstruction at
2026-07-21 16:58 PDT (2026-07-21 23:58 UTC). It launched v21/v22/v23/v24/v25
on isolated versioned named pipes, then called the same
`createLegacyDaemonAdapters` scanner as desktop startup: the v25 client found
exactly v21-v24. Every generation accepted 16 reconnect control/stream hellos;
desktop and two remote-profile paths sent six lifecycle attempts for each
persisted stale-mirror ID across process relaunch. All five daemons, all ten
PTY roots, and all ten descendants were alive afterward, with zero
`session-killed` events. This directly covers the v24→v25 current-to-next
upgrade boundary while keeping older generations reattachable.

The bounded `shutdown-dispose-failed` scenario also passed and now separates
authority from liveness explicitly: the late connection failed after endpoint
fencing while the refusing daemon, PTY root, and descendant remained alive
until exact fixture cleanup. The full Playwright command, including a fresh
Electron E2E build, exited successfully in 137.1 seconds, and no
`orca-9749-dg-*` directory remained. A final no-rebuild rerun passed both
scenarios in 99.1 seconds; the practical Electron clean-relaunch check passed
again in 24.0 seconds, and mixed-version retirement/live-session preservation
passed 2/2 in 23.1 seconds.

Latest focused verification includes 15/15 host adjudication tests, 948/949
focused production/RPC/renderer tests, 133/133 daemon discovery/adoption/
retirement/access-failure tests, all three typechecks, and 215
remote-runtime, multi-client, remote-server, SSH-provider, WSL-context, remote
PTY, and shared-control tests. The sole focused failure remains the untouched
Windows `/tmp` normalization baseline documented above. The experimental
`terminal-session.daemon-generation-reconnect-safety` reliability gate records
the invariant, RED/GREEN oracle, performance budget, promotion criteria, and
known platform/provider gaps.

## Fresh PR review after current-main integration

The explicitly requested post-PR `$internal-review-until-clean` pass completed
at 2026-07-21 18:02 PDT after merging `v1.4.150-rc.0` main, including the
remote-runtime network-recovery work from #9774. It found and fixed three
additional contract gaps:

- a stale PTY-exit callback could borrow a replacement or sibling handle from
  tab-wide state; lifecycle evidence now comes only from the exact callback PTY;
- the legacy close endpoint accepted lifecycle reasons without incarnation
  evidence; it now accepts only explicit user intent, with reasonless
  compatibility retained for authenticated legacy mobile and runtime clients;
- keep-on-unknown preserved the PTY but could leave its client mirror hidden;
  the host now republishes unchanged authority when inventory is unavailable.

The PR feedback loop also corrected the bulk-close payload assertion and made
the fixture protocol list collision-safe. The final native no-build run passed
both scenarios in 98.8 seconds, the fresh-build run passed in 137.1 seconds,
mixed-version retirement passed, and practical Electron restart/input passed
two scenarios with one intentionally skipped wedge scenario. Current-main
remote recovery (112 tests), focused close/reconnect suites, all 15 host
adjudication cases, all typechecks, reliability gates, max-lines, changed lint,
formatting, and diff checks pass. The full lint command remains blocked only by
pre-existing current-main switch-exhaustiveness and localization findings; no
remaining in-scope review finding is open.

## Additional clean review after `v1.4.150-rc.0` integration

This additional requested `$internal-review-until-clean` pass completed at
2026-07-21 18:56 PDT (2026-07-22 01:56 UTC) against merge base
`4d0e3f51ce0325a8f4670b4074618494984ab63d`. Round 1 found and fixed four
in-scope evidence/performance gaps:

- the native harness omitted production `DaemonPtyRouter.listProcesses`, so
  its synthetic lifecycle closes could pass through `unknown-liveness`; it now
  routes the production inventory, uses worktree-prefixed daemon session IDs,
  and requires every close to return `live-host-pty` with a republished
  snapshot;
- concurrent reconnect closes each started a full cross-generation PTY
  inventory; the host now shares one in-flight inventory and a deterministic
  count test proves two concurrent closes call `listProcesses` once;
- the renderer introduced a second snapshot-refresh map; it now reuses the
  existing environment/worktree remote-session deduper used by PTY reconnect;
- the reliability gate omitted the parked-tab callback path; its exact exiting
  PTY incarnation assertion is now part of the gate.

The review also added a wire-compatibility assertion proving that the additive
`{ reason: 'user' }` field is stripped by the previous `ActivateTab` server
schema. The repeated elegance and performance interrogation found no remaining
avoidable infrastructure, polling, subprocess churn, listener/handle leak, or
unbounded reconnect work. Round 2 re-read the full production and fixture diff,
constructed stale-publication, stale-handle, concurrent-close, mixed-client,
and old-server failure paths, and found no remaining proven in-scope issue.

Fresh verification includes all three typechecks; reliability-manifest,
max-lines, changed-file lint, formatting, and diff checks; 175 remote snapshot
and PTY transport tests; and the isolated lifecycle/reconnect adjudication
group. The strengthened native five-generation Windows harness passed after a
fresh Electron E2E build in 137.2 seconds, required `live-host-pty` for every
synthetic close, left every daemon/root/descendant alive, and left no
`orca-9749-dg-*` directory. The full focused gate reached 992/993 passing tests;
the only failure remains the untouched Windows `/tmp` versus `\\tmp`
`createRepo` baseline. The newly merged headless-update group reached 143/144
passing tests plus 25 skips; its only failure is an untouched LF-only
source-text assertion that does not match CRLF on Windows.

## Completion evidence matrix

| Original acceptance requirement                                                                                                             | Authoritative evidence                                                                                                                                                                                                                                                                                                                                             | Status                                                                   |
| ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| Complete recursive issue/PR/commit/tag investigation before production edits                                                                | The 41-row investigation matrix above, release chronology, and timestamped call-flow reconstruction cover every required starting item and every directly discovered related item. GitHub reads were completed before the first production edit.                                                                                                                   | Proven                                                                   |
| Explain survival, generation discovery/hello, broad shutdown caller, repeated reconnect kills, adjacent-bug distinctions, and compatibility | Sections A–E identify `disconnectDaemon`, `createLegacyDaemonAdapters` → `discoverLegacySessions` → control/stream hello, `cleanupDaemonForProtocol`, the stale-handle `pty-exit` path, #8275 versus #9704, and the warm legacy reattach contract.                                                                                                                 | Proven                                                                   |
| Isolated native-Windows multi-generation reproduction with external liveness oracle                                                         | `daemon-generation-reconnect-safety.spec.ts` uses an exact temporary user-data/runtime root, versioned pipe names, disposable ConPTY children, independent daemon/root/descendant PID-start identities, bounded output, and exact cleanup. The historical RED run above recorded real repeated `session-killed` events while daemon/client witnesses stayed alive. | Proven                                                                   |
| Exercise the desktop discovery path and current→next mixed-version upgrade                                                                  | The latest native run calls production `createLegacyDaemonAdapters`; v25 discovers exactly v21/v22/v23/v24, reattaches every original process incarnation, and leaves all five generations alive.                                                                                                                                                                  | Proven                                                                   |
| Reconnect bursts, app quit/relaunch, simultaneous clients, repeated IDs, profile and remote-runtime boundaries                              | Three router rebuilds, a full reconnect-client process exit/relaunch, parallel direct clients, and six desktop/two-profile lifecycle attempts per persisted ID are native. Environment-scoped close-intent and remote-runtime transport suites supply deterministic profile-switch/remote-server boundary proof.                                                   | Proven (native transport plus deterministic profile/provider boundaries) |
| `shutdown-dispose-failed` has a bounded non-authoritative state without conflating process death                                            | The native refusal fixture loses pipe authority within the deadline, rejects a late client, logs the failure, proves its daemon/root/descendant still live, then cleans only exact recorded fixture incarnations.                                                                                                                                                  | Proven                                                                   |
| Smallest immediate fix preserves legacy adoption and separates broader retirement/descendant cleanup                                        | Additive `session.tabs.closeLifecycle`, host liveness/incarnation adjudication, no destructive fallback, and state-only dead-headless retirement leave hello/adoption, #9138/#9229 retirement, and #9704/#9752 descendant semantics unchanged.                                                                                                                     | Proven                                                                   |
| Missing evidence keeps/audits; retirement is incarnation/profile safe; one owner has destructive authority                                  | Host tests cover unavailable inventory, stale publication/handle, live split siblings, renderer ownership, and authenticated legacy versus unattributed reasonless callers. Renderer tests cover exact environment handles and cross-profile intent isolation. Lifecycle requests never signal a PTY or relay renderer teardown.                                   | Proven                                                                   |
| Windows identity, dead-parent/never-adopted, ACL/access failure, rapid reconnect, and multi-client behavior                                 | Native CIM `CreationDate` identity is exact; the five-generation run covers rapid reconnect and concurrent clients. The 133-test daemon group covers never-adopted retirement, admission fencing, overlapping clients, and EACCES/EPERM process-signal failures.                                                                                                   | Proven (native identity/reconnect; deterministic ACL failure)            |
| No production PowerShell/CIM hot path, polling/listener/handle leak, or reconnect storm                                                     | Process enumeration exists only in fixture helpers; production adds no subprocess or timer. Refreshes coalesce by environment/worktree, listener ownership is unchanged, every fixture allocation has bounded cleanup, and 25-burst stress evidence is recorded above.                                                                                             | Proven                                                                   |
| Cross-platform, SSH, WSL, remote-server, and multiple-client compatibility                                                                  | 215 deterministic tests cover remote runtime/server, shared control, SSH provider, WSL host context, and PTY transport. Platform-specific fixture behavior is runtime-gated.                                                                                                                                                                                       | Deterministic proof complete; live Linux SSH/WSL unavailable             |
| Practical Electron restart behavior                                                                                                         | A real isolated Electron application created a daemon-backed terminal, wrote and restored output across clean app quit/relaunch, preserved the exact daemon PID, and accepted both keyboard and direct terminal input after reattachment.                                                                                                                          | Proven on native Windows (`electron-headless`, 24.0 s)                   |
| Internal review-until-clean and final gates                                                                                                 | The original three review rounds and both additional PR review loops are clean. The latest loop fixed four oracle/performance/gate gaps, then completed a clean full-diff re-review. Typecheck, lint, format, reliability manifest, max-lines ratchet, Electron build, native harness, and focused suites pass apart from the documented untouched baselines.      | Proven                                                                   |
| Public GitHub and real daemon safety                                                                                                        | No public GitHub mutation occurred. Fixture guards reject non-temporary roots and known Orca user-data paths; no installed pipe/token/session was discovered or contacted.                                                                                                                                                                                         | Proven                                                                   |

Live Linux SSH validation remains an explicit gap: the required throwaway
Docker target is unavailable on this runner (`docker` is not installed and no
Docker Desktop process or standard executable path exists), and `wsl.exe`
reports that WSL is not installed. A real remote or localhost was deliberately
not substituted. The Orca worktree comment was updated through the scoped
`worktree set --comment` CLI with the investigation, RED reproduction,
root-cause, implementation, native-validation, and clean-review milestones.
No terminal or daemon command was issued through the CLI, and no public GitHub
comment was made.
