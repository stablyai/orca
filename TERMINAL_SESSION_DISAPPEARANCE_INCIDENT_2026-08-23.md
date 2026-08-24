# Terminal session disappearance after failed ad hoc update — 2026-08-23

## Status

- Investigation status: root cause identified with high confidence; several supporting facts are proven directly by persisted state and logs.
- Investigation mode: read-only. No Orca restart, update retry, pane reopen, session kill, state restore, or profile edit was performed as part of this investigation.
- Incident machine: macOS/Darwin 26.5.1, arm64.
- Shell reported by the affected pane: `/opt/homebrew/bin/bash`.
- Local timezone used below: America/Phoenix (`MST`, UTC-07:00).
- Installed application during the incident: `1.4.189-hourly.202608231007`, commit `c3a1694b1d30`.
- Intended update: `1.4.189-adhoc.20260823180729`, commit `91a8c0977a39`.
- Both bundles use state schema 1 and daemon protocol 36.
- Source worktree HEAD during investigation: `e3327c2f3169`.

## Executive conclusion

This was a cascade of separate failures:

1. The ad hoc update did not install. During both ShipIt installation windows, a separate `/usr/bin/open /Applications/Orca.app` activation relaunched the still-installed hourly bundle. ShipIt then aborted with `App Still Running Error`.
2. Protocol-v36 daemon PID `6835` became unavailable for an unknown reason, and PID `26391` legitimately became the new current v36 daemon. That transition could strand PTYs actually owned by `6835`, but it cannot explain the bulk loss: only 5 of the 138 `unverifiable` primary PTYs have their latest frozen daemon event from `6835`; the other 133 point to other daemon PIDs.
3. The repeated app/daemon transitions exposed persisted PTY bindings whose exact owning daemon route was no longer reachable or registered. On terminal-pane visibility resume, the renderer called the boolean-oriented `pty.hasPty` path. For an old unmapped PTY, `DaemonPtyRouter.hasPty()` returned `false` after the owning adapter was omitted. That answer meant only that the current set of registered adapters did not contain the PTY, but the renderer treated it as authoritative **exited**.
4. The renderer's exit path cleared the pane binding and called `closeTerminalTab(..., { reason: 'pty-exit' })`, deleting the persisted terminal row and its unified tab without necessarily stopping the underlying process.
5. Worktree activation reconciled the two tab models. This made remaining tab shells disappear as affected worktrees were clicked.
6. Separately, a burst of 15 graceful daemon kills strongly matches false "missing worktree" cleanup. Those kills physically stopped a subset of sessions and worsened the incident, but they do not explain the bulk of the 158 removed terminal rows.

The user-visible message—"Orca couldn't confirm whether this terminal's previous session is still running, so it left the session untouched"—is the correct **unverifiable** behavior from a different reattach path. The destructive visibility-resume path incorrectly collapsed the same class of uncertainty into **exited**.

This was not a successful ad hoc installation followed by rollback, and it is not evidence that every agent process exited. The app lost a large amount of persisted terminal topology/UI state; many process and history artifacts survived.

The concise causal distinction is:

```text
daemon unavailable -> replacement daemon is expected
session absent from registered adapters -> route/authority is missing
matching owner reports exit -> session is exited
```

The incident incorrectly treated the second condition as the third.

## Confidence labels

- **Proven**: directly supported by immutable/stable persisted-state comparison, ShipIt logs, bundle metadata, or explicit daemon events.
- **High confidence**: the code path exactly produces the observed state transition and the timing/shape match, but per-mutation renderer logging is missing.
- **Unknown**: the retained evidence cannot attribute a caller or exact initiating event.

## Detailed timeline

Times are local MST unless a UTC timestamp is explicitly shown.

| Time | Event | Evidence/status |
| --- | --- | --- |
| 11:09:17 | Pre-incident state snapshot later stored as `orca-data.json.bak.1`. | Proven by file mtime and state contents. |
| 11:18:21 | Main PID `15010` records `updater_update_downloaded` for `1.4.189-adhoc.20260823180729`. | Proven in `main.trace.ndjson`. |
| 11:18:24 | PID `15010` invokes native quit/install. Quit breadcrumb records `daemonTeardown: "disconnect"`. ShipIt PID `78338` starts the install. | Proven. The updater shutdown intentionally disconnected from daemons rather than stopping their PTYs. |
| 11:18:51 | `/usr/bin/open` PID `79643` activates `/Applications/Orca.app`; launchd starts hourly Orca PID `79644`. | Proven from macOS unified logs collected during investigation. Exact caller of `open` is unknown. |
| 11:24:23 | ShipIt PID `78338` aborts because one target-app instance is running. | Proven: `SQRLInstallerErrorDomain Code=-9`, `App Still Running Error`. |
| 11:25:50 | Relaunched hourly PID `79644` records the ad hoc update downloaded again. | Proven in main trace. |
| 11:25:57 | PID `79644` invokes native quit/install; quit again records `daemonTeardown: "disconnect"`. ShipIt PID `72258` starts the second install. | Proven. |
| 11:26:22–11:26:23 | `/usr/bin/open` PID `77840` activates Orca; hourly PID `77841` starts. | Proven from macOS unified logs. Caller unknown. |
| 11:29:01 | PID `77841` is SIGKILLed. | Proven from macOS process logs; source of the signal is not retained. |
| 11:29:08–11:29:09 | `/usr/bin/open` PID `91473` activates Orca; hourly PID `91476` starts. | Proven from macOS unified logs. Caller unknown. |
| 11:30:11 | One `add-starting-agent-from-tab-e2e` PTY receives `session-killed`, `immediate:true`. | Proven daemon event; separate from the later graceful burst. |
| 11:31:31 | One `improve-cmd-j-ranking-with-recency` PTY receives `session-killed`, `immediate:true`. | Proven daemon event; separate from the graceful burst. |
| 11:31:54–11:32:45 | Fifteen PTYs across nine worktrees receive `session-killed`, `immediate:false`. | Proven events. Attribution to false missing-worktree reconciliation is high confidence. |
| 11:33:05 | New protocol-v36 daemon PID `26391` starts and becomes ready on `daemon-v36.sock`, replacing the prior protocol-v36 generation PID `6835`. | Proven. Why PID `6835` became unavailable is not recorded in `daemon.log`. |
| 11:36:16 | ShipIt PID `72258` aborts because one target-app instance is running. | Proven: second `App Still Running Error`. |
| 11:38–11:39 | Screenshots capture the app still on hourly and the missing-session UI. | User-provided evidence. |
| 12:10:11 | Post-incident state snapshot later stored as `orca-data.json.bak.0`. It reproduces the original state-loss measurement. | Proven by file mtime, hash, and state contents. |

The exact wall-clock moment of each renderer row deletion is not logged. The state snapshots bound the mutation window, while the restart, visibility, daemon, and kill events locate the likely trigger period.

## Finding 1: why the update failed

### Proven facts

The staged ad hoc bundle is valid and remains in ShipIt's cache:

```text
/Users/jinjingliang/Library/Caches/com.stablyai.orca.ShipIt/update.2pCRJKe/Orca.app
version: 1.4.189-adhoc.20260823180729
commit: 91a8c0977a39
daemonProtocolVersion: 36
```

The installed bundle was never replaced:

```text
/Applications/Orca.app
version: 1.4.189-hourly.202608231007
commit: c3a1694b1d30
daemonProtocolVersion: 36
```

ShipIt recorded two failed attempts:

```text
2026-08-23 11:18:25.850 Beginning installation
2026-08-23 11:24:23.461 Aborting update attempt because there are 1 running instances of the target app
2026-08-23 11:24:23.576 Installation cancelled: ... "App Still Running Error"

2026-08-23 11:26:00.620 Beginning installation
2026-08-23 11:36:16.660 Aborting update attempt because there are 1 running instances of the target app
2026-08-23 11:36:16.821 Installation cancelled: ... "App Still Running Error"
```

The three intervening activations were LaunchServices `/usr/bin/open` processes, not ShipIt's post-install success relaunch. Each activation occurred before the corresponding installation could complete, and each launched the old installed hourly bundle.

Both updater quits recorded:

```json
{"breadcrumb.name":"updater_will_quit_cleanup_started","breadcrumb.data":{"daemonTeardown":"disconnect"}}
```

Therefore the updater's normal quit path did not intentionally kill daemon-backed PTYs.

### Unknown caller of `/usr/bin/open`

The short-lived `open` process parents/callers were not retained in the available unified logs. Plausible sources include a manual Dock/Finder activation, a script, or an Orca CLI `open` operation, but none is proven.

`orca status` is ruled out as the source in current/incident-equivalent source: [`status`](src/cli/handlers/core.ts#L136) calls only `getCliStatus()`. [`openOrca()`](src/cli/runtime/client.ts#L208) is the path that calls [`launchOrcaApp()`](src/cli/runtime/launch.ts#L23), which can spawn `open` on macOS. This does not identify which caller ran during the incident.

### Ruled out

- Bad or incompatible ad hoc artifact: both bundles advertise the same state schema and daemon protocol.
- Successful install followed by rollback: installed bundle metadata never changed to the ad hoc build.
- ShipIt success relaunch: ShipIt logged cancellation, not installation completion, for both attempts.
- Updater-requested PTY teardown: both quit breadcrumbs say `disconnect`.

## Finding 2: daemon topology became unverifiable

Orca retained multiple daemon generations so older PTYs could remain attachable:

| Protocol | PID | Start time (UTC) | Notes |
| --- | ---: | --- | --- |
| 33 | `98955` | 2026-08-14T09:33:45.910Z | Legacy daemon; owns several incident-adjacent sessions. |
| 34 | `67978` | 2026-08-19T01:50:14.609Z | Legacy daemon. |
| 35 | `75742` | 2026-08-18T19:00:15.281Z | Legacy daemon. |
| 36 | `6835` | 2026-08-20T18:13:32.036Z | Current generation before incident replacement; emitted several kills. |
| 36 | `26391` | 2026-08-23T18:33:05.635Z | New current generation after restart/recovery. |

Additional persisted bindings referenced still older protocols such as v23/v26. Subsequent worktree-removal traces contain `ECONNREFUSED` for `daemon-v23.sock`, confirming that some saved ownership routes pointed at unavailable daemons.

Legacy adapter creation probes each old socket. If the socket probe fails, that adapter is omitted in [`createLegacyDaemonAdapters()`](src/main/daemon/daemon-init.ts#L1379). Loss of contact is therefore represented partly as absence from the router's adapter collection.

Per the execution-boundary contract, a missing/unreachable adapter makes process state **unverifiable**. It is not proof that the process **exited**.

### What PID `6835` can and cannot explain

PID `6835` becoming unavailable is an incident trigger, not a sufficient cause for the 158-row loss. Starting PID `26391` as the new v36 daemon was correct once the old v36 endpoint could not be used. The retained evidence cannot identify who or what stopped `6835`.

The frozen recovery catalog makes the scope mismatch explicit:

| Primary PTY classification | Latest event from PID `6835` | Latest event from another daemon PID | Total |
|---|---:|---:|---:|
| `unverifiable` | 5 | 133 | 138 |
| `exited` | 15 | 5 | 20 |

Historical event provenance does not prove present liveness. It does prove that the catalog cannot support a single-daemon explanation for the bulk loss. The 20 proven exits are backed by explicit exit/kill events, including sessions from the separate kill burst; the remaining 138 rows required an independent UI/persistence deletion mechanism.

The later recovery-v2 cutover supplies a control case. A newer app retained the still-live hourly daemon PID `26391`, despite its older bundle metadata, and preserved all 131 complete affected topologies in tracked worktrees. Same-protocol app/daemon version skew is therefore not itself a reason to replace a live daemon or delete its sessions.

"Not found in registered daemon adapters" is an adapter-lookup result. It can mean that the exact owner route was never reconstructed, its socket is unreachable, its adapter was omitted, or a same-protocol incarnation now occupies the fixed endpoint. It does not identify which condition occurred and does not prove process death.

## Finding 3: the destructive liveness misclassification

### Code path

On a hidden-to-visible terminal-pane transition, [`use-terminal-pane-lifecycle.ts`](src/renderer/src/components/terminal-pane/use-terminal-pane-lifecycle.ts#L2044) calls:

```text
reconcileMissingSessions({
  bindings: panePtyBindingsRef.current.values(),
  hasPty: window.api.pty.hasPty
})
```

The IPC handler in [`src/main/ipc/pty.ts`](src/main/ipc/pty.ts#L7856) selects a provider and calls synchronous `provider.hasPty(id)`. The handler can return `null` when no provider exists or a call throws, but it does not use the daemon router's asynchronous tri-state `probePtyLiveness()`.

For a daemon-backed provider, [`DaemonPtyRouter.hasPty()`](src/main/daemon/daemon-pty-router.ts#L80) does this:

```text
if a session-specific adapter route exists:
    return routed.hasPty(id)
otherwise:
    return current.hasPty(id) || any registered legacy adapter.hasPty(id)
```

If the actual owning daemon adapter is unreachable and omitted, the PTY is absent from every remaining adapter. The method returns `false`. That is a fabricated authoritative answer: it proves only "not present in the currently registered adapters," not "the process exited."

The same router already has `probePtyLiveness(id): Promise<boolean | null>`, which is the correct tri-state operation. The visibility-resume path bypasses it.

The renderer is correctly conservative only after it receives a tri-state value: [`shouldReconcileMissingSession()`](src/renderer/src/components/terminal-pane/terminal-dead-session-reconcile.ts#L66) acts only on literal `false`. Because main fabricated `false`, [`reconcileIfSessionMissing()`](src/renderer/src/components/terminal-pane/pty-connection.ts#L9497) calls `onExit(currentPtyId)`.

The exit cascade is:

1. Clear pane/tab PTY bindings in [`pty-connection.ts`](src/renderer/src/components/terminal-pane/pty-connection.ts#L2713).
2. `Terminal.handlePtyExit()` calls `closeTerminalTab(tabId, { reason: 'pty-exit' })` in [`Terminal.tsx`](src/renderer/src/components/Terminal.tsx#L1801).
3. `closeTab()` removes the terminal row from every `tabsByWorktree` array in [`terminals.ts`](src/renderer/src/store/slices/terminals.ts#L1618).
4. The same operation removes a matching unified terminal tab in [`terminals.ts`](src/renderer/src/store/slices/terminals.ts#L1831).
5. State persistence writes the reduced models to `orca-data.json`.

Crucially, `closeTab()` treats only reasons `user` and `cleanup` as physical session retirement. The `pty-exit` reason removes UI/persistence state without sending a provider kill. This exactly explains why many terminal records disappeared with no daemon `session-exited` or `session-killed` event and why detached agent processes could remain live.

### Confidence

This is the **high-confidence root cause of the bulk persisted row loss**.

It is not possible to prove that every one of the 158 rows traversed this exact function because renderer mutation logging does not record each `closeTerminalTab` call, liveness verdict, or reason with tab/PTY identity. However:

- The code path exactly produces both observed deletions: runtime terminal row plus unified terminal tab.
- It runs on the visibility transitions involved in clicking/reopening affected worktrees.
- The necessary daemon ownership uncertainty existed.
- 164 of 191 incident-referenced PTYs checked against daemon history had no corresponding exit/kill event.
- The state loss is much larger than the daemon kill count.

No alternative inspected path matches the state delta and missing kill events as closely.

## Finding 4: why tabs appeared to vanish worktree-by-worktree

Orca persists two related terminal-tab models:

- `workspaceSession.tabsByWorktree`: legacy/runtime terminal rows with the tab ID and top-level PTY ID.
- `workspaceSession.unifiedTabs`: the visible unified tab shell referencing the terminal row by `entityId`.

During an intermediate live-state observation, 138 of the 158 removed runtime rows still had unified tab shells. This transient state was later overwritten as the app continued persisting. It demonstrates that row loss and visible-tab cleanup occurred in stages.

When a worktree is activated, [`setActiveWorktree()`](src/renderer/src/store/slices/worktrees/session/set-active-worktree.ts#L50) invokes [`projectWorktreeTabModelReconciliation()`](src/renderer/src/store/slices/tabs.ts#L623). Once the runtime terminal row and reconnectable binding are gone, the unified terminal is considered orphaned and is removed. This makes sessions appear to disappear as each worktree is clicked.

By the stable 12:10 post-incident snapshot, none of the 158 removed runtime rows retained a matching unified terminal entry.

## Finding 5: the reattach failure and toast are related but not the row-deletion mechanism alone

The observed toast says:

> Orca couldn't confirm whether this terminal's previous session is still running, so it left the session untouched. Reopen this pane to retry. If this persists, please file an issue.

That wording explicitly represents an **unverifiable** verdict. It does not say or prove that the process exited.

The failed/empty reattach branch in [`pty-connection.ts`](src/renderer/src/components/terminal-pane/pty-connection.ts#L8280) can clear saved pane/tab PTY bindings when no PTY ID is returned. This makes later recovery harder, but that branch does not by itself remove the runtime terminal row. It therefore cannot explain the full 158-row deletion without the exit/close path or later reconciliation.

The existence of this safe toast path alongside the destructive boolean liveness path is the central semantic inconsistency:

```text
connection/reattach uncertainty -> unverifiable -> leave session untouched
visibility-resume adapter omission -> false -> exited -> delete terminal state
```

## Finding 6: separate false missing-worktree teardown

### Observed graceful kills

The daemon recorded 15 `session-killed` events with `immediate:false` from 11:31:54 through 11:32:45:

| Local time | Worktree | PTY suffix | Daemon PID | Client ID |
| --- | --- | --- | ---: | --- |
| 11:31:54.324 | `orca-top-level-cleanup` | `fa471831` | `98955` | `d8d97b7c-...` |
| 11:31:59.874 | `1.4.183-p0-orca-crashed-all-agent-sessions` | `8804d1a3` | `98955` | `d8d97b7c-...` |
| 11:32:06.374 | `add-more-e2e-tests` | `1f313236` | `98955` | `d8d97b7c-...` |
| 11:32:06.377 | `add-more-e2e-tests` | `79e61569` | `6835` | `985cf608-...` |
| 11:32:07.330 | `add-more-e2e-tests` | `ba88e6c5` | `6835` | `985cf608-...` |
| 11:32:13.651 | `add-starting-agent-from-tab-e2e` | `4ea40b01` | `6835` | `985cf608-...` |
| 11:32:13.652 | `add-starting-agent-from-tab-e2e` | `31c4cb12` | `6835` | `985cf608-...` |
| 11:32:13.652 | `add-starting-agent-from-tab-e2e` | `43f5e12a` | `6835` | `985cf608-...` |
| 11:32:13.652 | `add-starting-agent-from-tab-e2e` | `e7da1734` | `6835` | `985cf608-...` |
| 11:32:28.276 | `allow-create-automations-with-ai` | `e97a31de` | `6835` | `985cf608-...` |
| 11:32:28.277 | `allow-create-automations-with-ai` | `49fbac2f` | `6835` | `985cf608-...` |
| 11:32:41.658 | `analytics` | `5fb657da` | `98955` | `d8d97b7c-...` |
| 11:32:41.816 | `analytics` | `20adb901` | `98955` | `d8d97b7c-...` |
| 11:32:44.539 | `audit-default-settings` | `55fddb5f` | `6835` | `985cf608-...` |
| 11:32:45.638 | `audit-default-settings` | `048ff989` | `6835` | `985cf608-...` |

The sequence follows Git worktree inventory ordering and crosses daemon generations while preserving the same main-client grouping. The worktree directories survived and remained registered. This strongly matches [`stopMissingWorktreeTerminals()`](src/main/runtime/missing-worktree-terminal-reconciliation.ts#L68), called through `OrcaRuntimeService.teardownMissingManagedWorktreeTerminals()`.

That code computes `knownWorktreeIds - detectedWorktreeIds`, then calls `killAllProcessesForWorktree()` for each allegedly missing worktree. A partial or incorrect detected scan can therefore perform real graceful shutdowns against worktrees that still exist.

### Attribution caveat

Attribution is high confidence, not absolute. `daemon.log` records the kill, `immediate` flag, session, daemon PID, and client ID, but not the RPC name, reconciliation reason, scan generation, or callsite. No `terminal.close` spans were present during the graceful burst. The bulk pattern does not match the renderer manual-sleep path, which uses immediate kills.

### Two separate immediate kills

These should not be grouped with missing-worktree reconciliation:

| Local time | Worktree | PTY suffix | `immediate` |
| --- | --- | --- | --- |
| 11:30:11.893 | `add-starting-agent-from-tab-e2e` | `8972c618` | `true` |
| 11:31:31.967 | `improve-cmd-j-ranking-with-recency` | `c9fdd621` | `true` |

They match renderer `pty:kill`/transport-disconnect behavior but do not explain the later 15-session graceful sequence or the 158-row state loss.

## Persisted-state impact

### Stable comparison pair

The original incident measurement is reproducible using:

```text
before: /Users/jinjingliang/Library/Application Support/orca/profiles/local-default/orca-data.json.bak.1
mtime:  2026-08-23 11:09:17 -0700

after:  /Users/jinjingliang/Library/Application Support/orca/profiles/local-default/orca-data.json.bak.0
mtime:  2026-08-23 12:10:11 -0700
```

| Measure | Before | After | Detail |
| --- | ---: | ---: | --- |
| Runtime/legacy terminal rows | 978 | 838 | 158 old rows removed; 18 new rows added; net -140. |
| Unified terminal tabs | 596 | 447 | 166 old entries removed; 17 new entries added; net -149. |
| Unique PTY references across terminal-bearing state | 1,188 | 1,009 | 199 old PTY references lost; additions account for the different net delta. |
| Affected worktrees | — | 61 | 48 ended with zero terminal rows. |

Every one of the 158 removed rows:

- had a non-null PTY ID before the incident;
- had a matching unified terminal entry before the incident;
- belonged to a worktree listed in `activeWorktreeIdsOnShutdown`;
- was absent from `tabsByWorktree` in the post-incident snapshot;
- had no matching unified terminal entry left by the post-incident snapshot.

At the first filesystem check, 58 of the 61 affected paths still existed. Later, 57 of 60 main-repo worktrees were still registered by Git. The three absent worktrees were subsequent intentional removals:

- `create-scanning-issues`
- `sta-4062-folder-note-rollback`
- `sta-4064-phantom-folder-note`

The disappearance cannot be explained as ordinary cleanup of 61 deleted worktrees.

### Volatility warning

The running app continued to mutate `orca-data.json` and rotate backups during the investigation. A later comparison against the live file produced different totals because some records were recreated and additional tabs were opened/closed. Use the two hashed backup files above for incident analysis, not the current live state.

An intermediate observation that found 138 unified shells still present is no longer directly reproducible from the rotated files. It is retained here because it explains the staged, click-by-click symptom; the stable 12:10 snapshot captures the end state after reconciliation.

## Surviving process and history evidence

Read-only inspection after the incident found:

- At least 41 detached agent processes still live with PPID 1.
- 3,721 terminal `output.log` files still present.
- 164 of 191 incident PTYs examined had no daemon `session-exited` or `session-killed` event.

These are point-in-time observations, not a guarantee that the same processes remain live now. They prove that the incident was not uniformly "all agents exited." A large part of the loss was persisted topology/UI record deletion.

Do not equate missing UI records, failed socket contact, or the toast with process death. The correct verdict vocabulary is **live**, **unverifiable**, or **exited**.

## Near-match prior fix already present

Installed commit `c3a1694b1d30` includes:

```text
da6b9d80658168c3d94789d26a7a302295d6fce9
fix(terminal): stop orphaning live agent terminals across host restarts and graph syncs (#15644)
```

That change added host-admitted membership/runtime ownership preservation and tests for the case where graph sync prunes a live CLI terminal while its agent keeps running. Its test contract explicitly says assertions are made only for PTYs recorded as connected or exited—never **unverifiable**.

The current incident is adjacent but not fully covered:

- older pre-existing terminals may lack the newer ownership signal;
- the visibility-resume `pty.hasPty` path still fabricates `false` when an owning daemon adapter is unavailable;
- missing-worktree cleanup can physically stop sessions before graph preservation helps;
- failed reattach can clear the binding needed for later recovery.

The relevant liveness files are unchanged between installed commit `c3a1694b1d30` and the investigation worktree HEAD. This is not explained by inspecting only a newer source version.

## Evidence inventory

### Primary artifacts

```text
Current/live state:
/Users/jinjingliang/Library/Application Support/orca/profiles/local-default/orca-data.json

Stable pre-incident state:
/Users/jinjingliang/Library/Application Support/orca/profiles/local-default/orca-data.json.bak.1

Stable post-incident state:
/Users/jinjingliang/Library/Application Support/orca/profiles/local-default/orca-data.json.bak.0

Main trace:
/Users/jinjingliang/Library/Application Support/orca/logs/main.trace.ndjson

Daemon logs:
/Users/jinjingliang/Library/Application Support/orca/logs/daemon.log
/Users/jinjingliang/Library/Application Support/orca/logs/daemon.log.1
/Users/jinjingliang/Library/Application Support/orca/logs/daemon.log.2

ShipIt log:
/Users/jinjingliang/Library/Caches/com.stablyai.orca.ShipIt/ShipIt_stderr.log

Installed metadata:
/Applications/Orca.app/Contents/Resources/orca-local-build.json

Staged ad hoc metadata:
/Users/jinjingliang/Library/Caches/com.stablyai.orca.ShipIt/update.2pCRJKe/Orca.app/Contents/Resources/orca-local-build.json

Installed source bundle:
/Applications/Orca.app/Contents/Resources/app.asar
```

### User screenshots

```text
/var/folders/69/kktjrbf5569d0qvcyxjgmllm0000gn/T/TemporaryItems/NSIRD_screencaptureui_HMz6vr/Screenshot 2026-08-23 at 11.38.22 AM.png
/var/folders/69/kktjrbf5569d0qvcyxjgmllm0000gn/T/TemporaryItems/NSIRD_screencaptureui_KuOi0a/Screenshot 2026-08-23 at 11.39.19 AM.png
```

These are in a temporary directory and should be copied before macOS removes them if they are needed for a bug report.

### SHA-256 values captured at 2026-08-23 12:45:36 MST

| Artifact | SHA-256 |
| --- | --- |
| `orca-data.json.bak.1` | `34709f2dc87db86cecd13dfb7726f753c136419ce6ef0ce40cce7bc4c0df8fbe` |
| `orca-data.json.bak.0` | `383d229dc447523ed55ee836d1d6bf570edf7a372d8bcb604c6722caa4ef2de3` |
| `ShipIt_stderr.log` | `1900b6ab8acfc47f0c17ee71c1d2b64ef1e81c50e5ab64bba3fbc762c189c79e` |
| Installed `orca-local-build.json` | `eed31c47e4ea02599c5d6513a481bf2bf40c2c1e0f67aa70d5012ca205ea435a` |
| Staged `orca-local-build.json` | `89b86c5a4c79facdfcb12384df63b08c328e496454869782f3ec48c55a43de0c` |
| Screenshot 11:38:22 | `104f2cc5f0be0a34528073c8bdede235f4eaa18a691c3a048b2cb241bdf276f8` |
| Screenshot 11:39:19 | `1cccae152d01368c506fb689abba5a8d75b43784ff303fb4d26efa722b6dba2d` |

`main.trace.ndjson`, `daemon.log`, and the live state were still changing, so hashes of those live files are not durable evidence unless copies are made first.

## Affected worktree and PTY inventory

All PTY IDs share the local repo/worktree prefix. The suffixes below are sufficient to correlate against `daemon.log` and terminal history directories. Counts and suffixes come from the stable `bak.1 -> bak.0` comparison.

| Worktree | Removed rows | PTY suffixes |
| --- | ---: | --- |
| `orca-top-level-cleanup` | 1 | `fa471831` |
| `1.4.183-p0-orca-crashed-all-agent-sessions` | 1 | `8804d1a3` |
| `add-more-e2e-tests` | 1 | `ba88e6c5` |
| `add-starting-agent-from-tab-e2e` | 4 | `4ea40b01`, `8972c618`, `31c4cb12`, `43f5e12a` |
| `allow-create-automations-with-ai` | 1 | `49fbac2f` |
| `analytics` | 1 | `5fb657da` |
| `audit-default-settings` | 1 | `55fddb5f` |
| `auto-auto-pr-assignment-run-86-20260814T1645` | 2 | `b9b726f2`, `074c00d3` |
| `auto-continuous-readiness-checklist-8a-12p-4p-20260814T1500` | 1 | `2c0c1f2c` |
| `auto-continuous-readiness-checklist-8a-12p-4p-20260814T2300` | 1 | `72fbd9e4` |
| `auto-continuous-readiness-checklist-8a-12p-4p-20260815T1900` | 3 | `ca76565c`, `c88a58ad`, `34e82ad0` |
| `auto-continuous-readiness-checklist-8a-12p-4p-20260818T1900` | 3 | `3867ab5d`, `614960b9`, `343c97dc` |
| `auto-continuous-readiness-checklist-8a-12p-4p-20260818T2300` | 24 | `fa5e2406`, `593e9a00`, `1a8a174c`, `1bc85db0`, `eb3b9fe2`, `3921d7fb`, `edf568c4`, `fac0c631`, `e6430688`, `efca7e8b`, `6bae4f90`, `d5016fa5`, `d6499bd5`, `837371b4`, `7f7126e5`, `b0fcff2e`, `6bc4cece`, `23423419`, `59e2e93c`, `4885350c`, `8298b45c`, `2727bdb1`, `1a32dbcd`, `0232124a` |
| `auto-continuous-readiness-checklist-8a-12p-4p-20260819T0300` | 4 | `0a40db48`, `9f7d856b`, `19ac9fc3`, `b7feadd3` |
| `auto-continuous-readiness-checklist-8a-12p-4p-20260819T1500` | 1 | `c3e9dcbc` |
| `auto-continuous-readiness-checklist-8a-12p-4p-20260820T1900` | 13 | `c79d5dbc`, `e4ac2526`, `a0c3f640`, `505bd5f9`, `22e20c9f`, `ede1ab8a`, `701b0a50`, `39848d1b`, `04e88198`, `c7849e0a`, `d84ba2c4`, `290ed235`, `863608d1` |
| `auto-continuous-readiness-checklist-8a-12p-4p-20260821T0500` | 1 | `66a64cb2` |
| `auto-continuous-readiness-checklist-8a-12p-4p-20260821T1622` | 7 | `a29ba124`, `501dddb0`, `02d0f9bb`, `5334f289`, `8b0aa695`, `6187ebba`, `2d2f4519` |
| `auto-continuous-readiness-checklist-8a-12p-4p-20260821T2300` | 2 | `f2e1c169`, `13b2d8a3` |
| `auto-continuous-readiness-checklist-8a-12p-4p-20260822T0300` | 1 | `0396191b` |
| `auto-continuous-readiness-checklist-8a-12p-4p-20260822T2300` | 1 | `e9af8bc5` |
| `auto-continuous-readiness-checklist-8a-12p-4p-20260823T0300` | 1 | `a2dbb054` |
| `auto-daily-agents-hot-topics-digest-gtm-run-7-20260814T1700` | 1 | `37f05f5c` |
| `auto-daily-prod-release-scan-run-11-20260815T1754` | 1 | `59091a79` |
| `auto-daily-prod-release-scan-run-13-20260817T1740` | 4 | `1a405155`, `2bf19ea3`, `2363fd5a`, `9ea3c2e7` |
| `auto-daily-prod-release-scan-run-14-20260818T1740` | 1 | `06c6bab4` |
| `auto-daily-prod-release-scan-run-16-20260820T1708` | 6 | `845a4da1`, `d19e8f14`, `c2329e22`, `6b298232`, `65b864bf`, `21553287` |
| `auto-daily-prod-release-scan-run-18-20260821T1740` | 3 | `a313bcea`, `04230ccf`, `782038ec` |
| `auto-daily-prod-release-scan-run-19-20260822T1740` | 1 | `6613c1d9` |
| `auto-daily-prod-release-scan-run-20-20260823T1740` | 1 | `57026aac` |
| `auto-daily-prod-release-scan-run-6-20260811T1700` | 2 | `2acfc72b`, `69aa6e2f` |
| `auto-daily-prod-release-scan-run-7-20260812T1700` | 3 | `34de7420`, `9fb50f61`, `7ec7c820` |
| `auto-daily-prod-release-scan-run-8-20260813T1700` | 3 | `64f6db4a`, `0da91944`, `db45412e` |
| `auto-e2e-tests-autofix-scheduled-ci-1h-run-10-20260823T0200` | 2 | `98a89cf0`, `0997b509` |
| `auto-e2e-tests-autofix-scheduled-ci-1h-run-11-20260823T0700` | 2 | `dd1678cf`, `824b1859` |
| `auto-e2e-tests-autofix-scheduled-ci-1h-run-2-20260819T0200` | 4 | `b5d80904`, `de00197d`, `3a7d2133`, `0befdc75` |
| `auto-e2e-tests-autofix-scheduled-ci-1h-run-5-20260820T0700` | 3 | `35cc8ecd`, `1f90f984`, `6c4f82c3` |
| `auto-e2e-tests-autofix-scheduled-ci-1h-run-6-20260821T0200` | 2 | `e4d686e8`, `de5a3cf2` |
| `auto-e2e-tests-autofix-scheduled-ci-1h-run-7-20260821T0700` | 2 | `8263332e`, `eedea3aa` |
| `auto-e2e-tests-autofix-scheduled-ci-1h-run-8-20260822T0200` | 1 | `3d9b1dac` |
| `auto-e2e-tests-autofix-scheduled-ci-1h-run-9-20260822T0700` | 1 | `a95190fc` |
| `being-able-to-select-parent-worktree-when-creating-worktree` | 2 | `e57e2dd1`, `a8342e80` |
| `close-tab-on-mobile-back-to-prev` | 2 | `91aa4322`, `6684a1fc` |
| `commit-now-takes-a-long-time` | 3 | `1d81bbec`, `f01fe425`, `23acb531` |
| `create-scanning-issues` | 1 | `fe3a15cb` |
| `create-ssh-worktree-error` | 3 | `b70d565b`, `a2eba1ca`, `9cc25c3c` |
| `custom-agents` | 2 | `2c152915`, `85065bfc` |
| `daemon-downgrade-recovery` | 1 | `07c92549` |
| `default-child-workspace` | 1 | `752b0330` |
| `deleting-skill` | 1 | `b3d49597` |
| `discord-support` | 1 | `70675bd9` |
| `display-failed-automations` | 1 | `e1547367` |
| `e2e-automation` | 2 | `a93a2bba`, `bde9cf3c` |
| `enterprise-governance` | 1 | `7ee5502d` |
| `extension-planning` | 1 | `0cb31d71` |
| `fix-notes-send-name-send-targets-after-their-tab` | 3 | `3b9fd0c0`, `1b189bf4`, `6e7c347f` |
| `pure-extract-orca-runtime` | 3 | `48533547`, `bc7e0f51`, `bb0ce93b` |
| `split-pty-connection` | 2 | `f0265ed6`, `183c573b` |
| `split-task-page` | 4 | `75ea0008`, `7c525cae`, `4042761c`, `d3cfd89c` |
| `sta-4062-folder-note-rollback` | 3 | `11818262`, `41a4a575`, `98c13247` |
| `sta-4064-phantom-folder-note` | 3 | `c4d72e5c`, `4b2345f4`, `2effc0c4` |

## Read-only reproduction commands

Use copies of the artifacts when possible. The following commands do not mutate Orca state.

### Confirm bundle versions

```bash
jq . '/Applications/Orca.app/Contents/Resources/orca-local-build.json'
jq . '/Users/jinjingliang/Library/Caches/com.stablyai.orca.ShipIt/update.2pCRJKe/Orca.app/Contents/Resources/orca-local-build.json'
```

### Confirm ShipIt failure

```bash
rg -n '11:18:|11:24:|11:25:|11:26:|11:36:|App Still Running Error|Aborting update attempt' \
  '/Users/jinjingliang/Library/Caches/com.stablyai.orca.ShipIt/ShipIt_stderr.log'
```

### Count terminal models in a snapshot

```bash
jq '{
  terminalRows: ([.workspaceSession.tabsByWorktree[] | .[]] | length),
  unifiedTerminalTabs: ([.workspaceSession.unifiedTabs[] | .[] | select(.contentType == "terminal")] | length)
}' '/Users/jinjingliang/Library/Application Support/orca/profiles/local-default/orca-data.json.bak.1'
```

Run the same command against `orca-data.json.bak.0` for the post-incident totals.

### Extract incident-adjacent daemon kills

```bash
jq -rc '
  select(
    .ts >= "2026-08-23T18:29:00Z" and
    .ts <= "2026-08-23T18:34:30Z" and
    (.event == "session-killed" or .event == "session-exited")
  ) |
  [.ts, .pid, .event, .sessionId, .immediate, .code, .cause, .clientId] |
  @tsv
' '/Users/jinjingliang/Library/Application Support/orca/logs/daemon.log'
```

### Locate stale daemon socket failures

```bash
rg -n 'ECONNREFUSED|daemon-v[0-9]+\.sock' \
  '/Users/jinjingliang/Library/Application Support/orca/logs'
```

## Recommended code fixes

The permanent PTY-owner alternatives, their performance models, migration paths, and tradeoffs are
specified in
[`PTY_DAEMON_IDENTITY_ARCHITECTURE_DESIGN.md`](PTY_DAEMON_IDENTITY_ARCHITECTURE_DESIGN.md).

### 1. Make visibility-resume liveness tri-state end to end

- Do not use synchronous `DaemonPtyRouter.hasPty()` for destructive reconciliation.
- Route `pty:hasPty` through `probePtyLiveness()` or rename the IPC to make its verdict semantics explicit.
- Return `false` only when the owning execution host/daemon authoritatively reports absence or exit.
- Return `null`/`unverifiable` when the PTY has no established route, an expected legacy adapter is missing, the socket is unreachable, the provider is unregistered, or discovery is incomplete.
- Keep `reconcileMissingSessions()` restricted to literal authoritative `false`.

Required regression test:

1. Persist a PTY owned by an older daemon generation.
2. Start a new current daemon while making the old socket unreachable/omitted.
3. Trigger terminal visibility resume.
4. Assert the verdict is `null`, `onExit` is not called, PTY bindings remain, and both terminal models remain persisted.

Cover local, folder workspace, SSH, and mixed client/host version cases. For SSH, loss of contact must remain **unverifiable**.

### 2. Preserve bindings on unverifiable reattach

- Distinguish `exitedBeforeAttach` from transport failure or declined unverifiable resume.
- Do not clear `ptyIdsByLeafId`, tab `ptyId`, or ownership records on `ECONNREFUSED` alone.
- Store retry metadata separately so reopening the pane can attempt the same route again.
- Ensure a failed retry cannot create a fresh shell over a still-live detached agent without an explicit recovery choice.

The first guarded build fixed main-process tri-state liveness but exposed a second renderer defect: `terminal_pane_owner_unverified` produced an undefined reattach result, after which the connection layer cleared the saved binding and started a replacement shell while displaying a toast that claimed the binding was untouched. Recovery-v2 adds the required renderer guard. Both layers must remain covered because either one can turn uncertainty into destructive state replacement.

### 3. Persist exact owner and incarnation identity

- Treat protocol version as compatibility, never daemon identity.
- Persist execution host, daemon incarnation, session incarnation, and logical PTY identity separately.
- Rebuild routes to the exact recorded owner after app restart; do not infer ownership from whichever daemon currently occupies `daemon-v<protocol>.sock`.
- Accept an authoritative exit only from the matching execution host and daemon/session incarnation.
- Permit a new PTY to reuse a logical recovery identity only with a new incarnation and an explicit authoritative-missing or user-approved recovery decision.
- Keep provider continuation distinct from raw PTY reattachment. Resuming a saved Codex/Claude conversation creates a new process; it does not prove that the old raw process exited.

If raw terminals must survive a true daemon crash, their PTY master must be held by a per-session broker or another independently surviving process. A replacement control daemon cannot reconstruct a PTY master file descriptor that died with its owner.

### 4. Harden missing-worktree teardown

- Treat a detected worktree list as destructive authority only when scan completeness is proven, not merely when the Git command exits successfully.
- Revalidate every allegedly missing path/worktree immediately before shutdown.
- Consider requiring two consistent authoritative scans separated by a graph/scan generation boundary before killing live PTYs.
- Include folder workspaces and execution-host scope in the reconciliation contract.
- Never infer process exit from SSH or relay contact loss.
- Abort the teardown if the detected set collapses suspiciously relative to the prior inventory.

Required regression test:

1. Return a successful but partial worktree scan that omits registered, existing worktrees.
2. Ensure no PTYs for omitted survivors are stopped.
3. Cover sessions distributed across current and legacy daemon adapters.

### 5. Protect ShipIt's installation exclusivity window

- Record an update-in-progress/handoff sentinel before quitting.
- On LaunchServices activation during that window, defer desktop startup or hand control back to ShipIt instead of starting the old installed bundle.
- Ensure CLI `open` honors the sentinel.
- Log activation provenance where possible: parent PID, responsible process, CLI operation, handoff token, and update attempt ID.
- Test repeated external activation while ShipIt is waiting for the target app to stay closed.

### 6. Add forensic logging

The absence of these fields prevented absolute attribution:

- Every terminal row removal: tab ID, PTY ID, worktree ID hash/shape, close reason, liveness verdict, verdict source, provider route, daemon protocol, and renderer action.
- Every daemon kill: RPC method, caller subsystem, reason, worktree-reconciliation attempt ID, scan generation, and destructive/non-destructive classification.
- Missing-worktree reconciliation: known count, detected count, authoritative flag, scan source, omitted-ID hashes, cache generation, and per-item revalidation result.
- Daemon adapter discovery: expected generation, socket probe result, PID identity result, adapter omitted/retained decision, and PTY route count.
- Update activation: attempt ID plus the process responsible for reopening the app.

Avoid logging raw absolute remote paths where existing privacy conventions require path shapes or hashes.

## Open questions

1. What invoked the three short-lived `/usr/bin/open` processes?
2. Why was hourly PID `77841` SIGKILLed at 11:29:01, and by whom?
3. Why did protocol-v36 daemon PID `6835` become unavailable and get replaced by PID `26391` at 11:33:05?
4. What caused an apparently successful/authoritative Git worktree scan to omit existing registered worktrees before the 15 graceful kills?
5. Did every one of the 158 row deletions traverse visibility-resume reconciliation, or did another exit callback contribute? Current logs cannot resolve individual mutations.
6. Which of the old detached agents are still live now, and which retained output/history is recoverable?
7. Did older pre-`da6b9d8065` terminal records lack ownership metadata needed by the near-match graph-sync fix?

## Recovery and evidence-preservation cautions

- Do not test fixes or reproduction steps against the only copy of the affected profile.
- Do not treat pane reopening, app restart, failed attach, or worktree activation as read-only; each can persist reconciliation results and rotate backups.
- Preserve `orca-data.json.bak.1`, `orca-data.json.bak.0`, all `daemon.log*`, `main.trace.ndjson`, `ShipIt_stderr.log`, the staged ad hoc bundle metadata, terminal history directories, and the temporary screenshots before further debugging.
- Inventory candidate processes and output logs before attempting to reconstruct tabs.
- A missing daemon route is **unverifiable**, not evidence that a process exited.
- Recovery should rebuild UI records only after matching PTY/process identity and execution host. Never attach a local record to an SSH/relay or different daemon session based only on a reused short suffix.

No live Orca profile, PTY, daemon, or process was mutated in producing this report or the offline recovery package below.

## Recovery package and cutover status

The frozen evidence now has a deterministic recovery package under
`recovery/2026-08-23-session-disappearance/`:

- `RECOVERY_CATALOG.md` and `RECOVERY_CATALOG.json`: 158 incident tabs across 61 worktrees, including every pane PTY, latest daemon event, history evidence, profile presence, and recommended recovery action.
- `orca-data.recovery-candidate.json`: an offline merge based on the frozen current profile.
- `RECOVERY_MERGE_VALIDATION.json`: topology, preservation, uniqueness, group-reachability, exclusion, count, and SHA-256 gates.
- `generate-recovery-artifacts.mjs`: deterministic generator. Pass `--current <post-quit-orca-data.json>` and `--output-dir <cutover-dir>` to rebase the candidate on a consistent post-shutdown live profile.

Classification and candidate totals:

| Item | Count |
|---|---:|
| Incident tabs | 158 |
| Worktrees | 61 |
| Pane PTYs | 191 |
| Primary PTYs `unverifiable` | 138 |
| Primary PTYs `exited` | 20 |
| Missing layouts added to the frozen-base candidate | 135 |
| Missing legacy tabs added | 135 |
| Missing unified tabs added | 9 |
| Missing tab groups added | 3 |

All 138 `unverifiable` primary PTYs have surviving history directories. None of the 20 `exited` primary PTYs does. The candidate never overwrites current layout/tab records and does not add missing records for the 20 proven-exited sessions.

### Guarded build

The liveness fix is committed on `debug-session-disappear`:

- Fix commit: `25ae8e8edf`
- Current guarded branch head after merging `origin/main`: `05a27fb4274ad23c8485bb71af42fde9a8c67028`
- Signed/notarized ad hoc workflow: <https://github.com/stablyai/orca/actions/runs/32663499082>

The IPC now waits for local PTY-provider startup, prefers `probePtyLiveness()`, preserves `null` as `unverifiable`, and uses legacy `hasPty()` only when no tri-state probe exists. Focused validation passed 35 tests plus the Node typecheck.

### Additional restart hazard: stale ShipIt state

`~/Library/Caches/com.stablyai.orca.ShipIt/ShipItState.plist` remains active and records:

```text
bundleIdentifier = com.stablyai.orca
launchAfterInstallation = true
targetBundleURL = file:///Applications/Orca.app/
updateBundleURL = file:///Users/jinjingliang/Library/Caches/com.stablyai.orca.ShipIt/update.2pCRJKe/Orca.app/
```

Therefore a plain restart is unsafe even after preparing a candidate: ShipIt could later overwrite the guarded app with the stale unguarded ad hoc bundle. After the normal GUI process exits and only after confirming no ShipIt process is running, move the entire ShipIt cache into the cutover evidence directory. Do not delete it.

### Controlled cutover gates

1. Validate the signed/notarized arm64 app before downtime: exact commit/version metadata, bundle ID, architecture, readable state schema, attachable daemon protocol, strict code signature, Gatekeeper acceptance, and notarization staple.
2. Capture pre-cutover `orca status`, full terminal topology, and worktree process inventory.
3. Quit the GUI normally and wait for the main process to exit. Do not kill or restart the daemon; daemon survival is expected. A local in-process fallback PTY remains a residual restart risk.
4. Copy the full profile directory and profile index after shutdown. Quarantine the stale ShipIt cache.
5. Regenerate the recovery candidate against that exact post-quit `orca-data.json`. Require the validation base SHA-256 to equal the post-quit live SHA-256.
6. While `/Applications/Orca.app` is absent, atomically activate the rebased candidate and guarded app. This blocks the unknown external `open` actor from relaunching the hourly build during the swap.
7. Launch the exact app path. Before clicking through worktrees, require a new runtime ID, guarded version, ready runtime/graph, no degraded or stale-bundle errors, and no loss of pre-cutover PTY IDs.
8. Roll back the profile and app bundle together if any gate fails. Never run the old hourly app against the guarded recovery candidate alone.

## Post-cutover outcome: preservation succeeded, automatic reattachment did not

The controlled cutover completed with guarded app version
`1.4.189-adhoc.20260823201001`, runtime ID
`f73694d1-31b5-4abb-bc86-3123aae61783`, and surviving hourly daemon PID `26391`.
The stale ShipIt cache is quarantined under the cutover evidence directory.

The initial post-launch merge validation found all 138 `unverifiable` incident topologies
reachable in the profile. Subsequent live inspection established that this was a persistence
result, not a runtime-recovery result:

- 48 of 51 affected `unverifiable` worktrees are still tracked by Orca.
- Those 48 worktrees contain 131 incident sessions.
- 130 incident sessions still have their exact original PTY topology in the live profile.
- Three original incident panes, all in one worktree, are directly listed, connected, writable,
  and readable.
- 73 tracked sessions have saved provider-session records; all 131 have preserved terminal
  history.
- Seven records belong to three worktrees whose directories no longer exist. Their unified-tab
  reachability was later removed by missing-worktree cleanup, while frozen evidence remained.
- The remaining non-exact record, `deleting-skill`, had already been rebound to blank replacement
  shells before the guarded cutover.

The guarded IPC fix prevents `null` liveness from being misclassified as `exited`; it does not
recreate a missing legacy daemon route. Live verification found a second defect: main correctly
throws `terminal_pane_owner_unverified` without retiring persistence, but the renderer transport
returns an undefined reattach result after reporting that marker. The connection layer treats the
undefined result as stale/dead, clears the leaf/tab PTY bindings, and starts a fresh shell. The
toast saying the session was left untouched is therefore false. A second renderer guard is
required before affected panes can be opened safely.

A representative provider fallback succeeded for `close-tab-on-mobile-back-to-prev`: Codex
session `01a0068d-2be5-77b1-8a9e-cc7cda073fd2` resumed into a new live Orca tab without receiving
a new prompt. This establishes that provider continuation is technically available, but the new
tab must remain idle while the original raw PTY is `unverifiable`; otherwise two surviving agents
could be driven concurrently. Provider resume is safe after an authoritative `exited` verdict or
an explicit user decision to abandon the uncertain raw route. Plain shell tabs require
terminal-history export and cannot be assumed to retain process state.

Full live accounting, exact identifiers, rollback locations, and the safe recovery sequence are
recorded in
`recovery/2026-08-23-session-disappearance/cutover-20260823T201851Z/POST_CUTOVER_RECOVERY_STATUS.md`.

## Recovery-v2 cutover and first successful controlled recovery

The second renderer guard was committed as `bd09097708` and shipped in signed/notarized arm64 build
`1.4.189-adhoc.20260823204916`. The installed app is now that build, runtime ID
`f5c43687-8851-4f0b-8222-1b4292caa125`, with runtime and graph both `ready`. Surviving hourly daemon
PID `26391` remained alive throughout the upgrade.

The external-launch race also reproduced during this cutover. After v1 GUI PID `65542` exited
normally, the still-installed v1 bundle reopened as PID `96491` at 14:04:49 MST before the swap.
The second attempt normally quit that process and immediately moved the old bundle out of
`/Applications/Orca.app`, removing the relaunch target before the final profile snapshot and v2
activation. This directly reinforces the original finding that an external activation can defeat a
ShipIt-style installation window even when Orca itself quits correctly.

The final isolated pre-v2 profile SHA-256 was
`9bdd64cbfa764021149d281b8390797ed214916064628035db83b950c172d347`. Deterministic
validation before and after v2 launch preserved 1001 layouts and all 131 complete incident
topologies in tracked worktrees. ShipIt remains quarantined.

One affected worktree was then activated as a controlled recovery probe:

```text
auto-e2e-tests-autofix-scheduled-ci-1h-run-9-20260822T0700
tab d6d43b87-9d6b-4c48-87cc-641719ecab8e
leaf 4d1848a5-e6ae-4108-b59e-e049791b70d9
PTY @@a95190fc
Codex session 01a02a6a-01fc-74c2-b77a-1d1f674d66e0
```

The current daemon authoritatively lacked that old raw session, so Orca created one replacement
daemon session under the same logical PTY ID and resumed the saved Codex provider session in the
same tab. Core layout, legacy-tab, unified-tab, leaf, and PTY binding data were byte-identical before
and after. The new runtime handle is `term_88f38ceb-d943-4c3c-8b36-b844616ad603`, incarnation
`761a724d-5d78-42c2-946b-8dd962f5a217`; it is connected, writable, and TUI-idle. No prompt was sent.

This live probe exercised authoritative-missing provider recovery, not the owner-unverified branch.
The latter is covered by the focused 10-test renderer suite and must preserve bindings without
creating a new PTY. Full build verification, cutover evidence, the exact distinction between raw
reattach and provider continuation, rollback paths, and safe next steps are recorded in
`recovery/2026-08-23-session-disappearance/cutover-v2-20260823T140110MST/RECOVERY_V2_CUTOVER_STATUS.md`.
