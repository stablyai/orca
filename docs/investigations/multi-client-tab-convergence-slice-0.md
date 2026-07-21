# Multi-client tab convergence: Slice 0 investigation

Date: 2026-07-16  
Base: `origin/main` / `827cd49f410f042ae29ee886538d5aa8cf8c0c46`  
Outcome: **exit gate not passed** — do not begin broad implementation from this report

## Scope and safety

This investigation used the fresh `origin/main` worktree and did not modify PR #9053. Diagnostics below contain only runtime/worktree/tab identities and counts; no terminal output, editor content, credentials, cookies, or SSH secrets were captured.

The available Orca instance exposed one local runtime and no second physical client, direct-SSH target, or Remote Orca Server target. The coordinator explicitly chose to close Slice 0 with the gate marked not passed rather than provision live resources. Therefore several code mechanisms below are confirmed, but retained-snapshot behavior and the reported real-world A/B symptoms are **not yet fully attributed**.

## Evidence gathered

### 1. Legacy relay writeback is reproducible and terminal-only

**Proven code path:**

- Every renderer session mutation schedules `remoteWorkspace.setForConnectedTargets` after local persistence (`src/renderer/src/App.tsx:1156`).
- Connect hydration also uploads local state when the relay is empty and the renderer has local tabs (`src/renderer/src/hooks/useIpcEvents.ts:590-615`).
- Main classifies a target only by `repo.connectionId` (`src/main/ipc/remote-workspace.ts:223-225`), exports the full target partition, and emits `workspace.patch { kind: 'replace-session' }` (`src/main/ipc/remote-workspace.ts:306`). It does not consult durable runtime ownership.
- `RemoteWorkspaceSession` projection includes terminal tabs/layouts but no editor or browser tabs (`src/shared/remote-workspace-session-projection.ts:35-111`).
- The focused main test proves an explicitly hydrated target sends `workspace.patch`; the relay test proves the full replacement is accepted under revision CAS and broadcast semantics.

**Classification:** this path can replace A's terminal bindings. It cannot directly create stale file/browser tabs. The replacement protocol itself contains no PTY-kill operation, so code-level evidence says it mutates session/tab bindings, not the process. Whether the reporter's underlying PTY survives still requires live A/B observation.

### 2. Orphan `openFiles` publication is deterministically reproduced

`buildMobileSessionTabSnapshots` enumerates every `openFiles` worktree, and after unified/group projection it deliberately loops over remaining `openFiles` and publishes files absent from the unified tab model (`src/renderer/src/runtime/sync-runtime-graph.ts:795-842`). Existing tests characterize this as fallback behavior, including missing unified editor tabs.

**Classification:** “B shows a file A's tab bar does not show” has a proven runtime-publication path independent of the relay protocol. Hydration readiness is not part of the snapshot builder's contract, so the fallback is not bounded to a non-destructive hydration phase.

### 3. Generic file/browser close is one-way and cache-retaining

For a non-terminal, non-headless-browser tab, `closeMobileSessionTab` calls optional `notifier.closeSessionTab` and immediately returns `{ closed: true }` (`src/main/runtime/orca-runtime.ts:5307-5309`). The notifier is a one-way renderer send (`src/main/window/attach-main-window-services.ts:333`). Main neither waits for renderer acknowledgement nor removes the cached runtime snapshot at that point.

**Classification:** an already-absent renderer file can be reported closed while remaining in main's snapshot and later reappearing after client-side suppression expires. Dirty/pinned refusal cannot currently be represented to the caller.

### 4. A retention mechanism exists, but the stale-snapshot symptom remains unverified

`markRendererReloading` changes graph status and invalidates terminal handles but does not clear `mobileSessionTabsByWorktree` (`src/main/runtime/orca-runtime.ts:21155-21169`). `markGraphUnavailable` clears terminal graph maps but likewise does not directly clear that map (`src/main/runtime/orca-runtime.ts:21178-21199`). No `RuntimeSessionAuthorityHealth` or `authorityEpoch` type exists on `origin/main`.

**Classification:** static inspection identifies a plausible retention mechanism, not a completed reproduction. Subsequent headless hydration/merge behavior can transform retained snapshots, so whether stale file/browser state is actually served after renderer loss—and whether it explains visible-host or `orca serve` reports—remains a mandatory Slice 0 unknown.

### 5. Epoch ordering accepts E1 after E2

Main's renderer gate rejects only non-increasing versions when the publication epoch is the same (`src/main/runtime/orca-runtime.ts:22745-22763`). Web and mobile clients use the same rule: any different epoch is accepted as a new generation (`src/renderer/src/runtime/web-session-tabs-sync.ts:204-215`, `mobile/src/session/session-tab-snapshot-gate.ts:23-33`). Existing tests explicitly require accepting a reset version from a different renderer epoch.

**Classification:** the sequence E1 -> E2 -> delayed E1 is currently accepted at both main and clients. There is no retired-epoch set or authenticated runtime-incarnation fence.

### 6. Inventory/subscription has a lost-update window

`session.tabs.subscribe` awaits `listMobileSessionTabs`, emits the initial snapshot, and only then installs `onMobileSessionTabsChanged` (`src/main/runtime/rpc/methods/session-tabs.ts:139-168`). `subscribeAll` has the same ordering (`src/main/runtime/rpc/methods/session-tabs.ts:199-239`). A mutation between list capture and listener registration is unobserved.

**Classification:** reconnect can miss an update even when per-snapshot version checks are correct. Existing multi-client integration tests cover navigation isolation, not this boundary.

### 7. `worktree.ps` saved-tab liveness inflation is deterministic but belongs with #9053

After counting runtime leaves and connected PTYs, `getWorktreePs` raises `liveTerminalCount` to persisted tab count and sets `hasAttachedPty` from any non-null saved `tab.ptyId` (`src/main/runtime/orca-runtime.ts:12960-12989`). A successful empty provider listing therefore still reports saved metadata as live.

**Classification:** this is a separate deterministic summary bug tied to the stale persisted-terminal source addressed by PR #9053. It should remain an independent narrow change and must not be used as proof of the broader A/B relay/runtime symptoms.

## Worktree mode observed

The active investigation worktree was classified as **local** from durable `hostId: "local"`; `orca worktree ps` reported three connected PTYs and `orca terminal list` reported the same three live terminal surfaces. No direct-SSH or runtime-owned worktree was available for a mixed-owner reproduction.

## Focused validation

Command:

```bash
pnpm exec vitest run --config config/vitest.config.ts \
  src/main/ipc/remote-workspace.test.ts \
  src/relay/workspace-session-handler.test.ts \
  src/renderer/src/runtime/sync-runtime-graph.test.ts \
  src/renderer/src/runtime/web-session-tabs-sync.test.ts \
  src/main/runtime/graph-sync-mobile-snapshot-gating.test.ts \
  src/main/runtime/multi-client-navigation-isolation.integration.test.ts \
  src/main/runtime/rpc/methods/session-tabs.test.ts
```

Result: **7 files, 144 tests passed**. These tests validate current behavior and code-level characterizations; they do not satisfy the live Slice 0 gate. There is no two-desktop legacy-relay harness on `origin/main`: the nearest coverage is the in-process runtime multi-client integration test, relay handler unit tests, and the `ORCA_E2E_WEB_CLIENT` Playwright path.

A first raw `vitest` invocation without the repository config produced alias/mobile dependency-resolution errors. Re-running with `config/vitest.config.ts` passed; those initial errors were test invocation errors, not product failures.

## Mandatory gate status

| Slice 0 item | Status | Evidence / gap |
| --- | --- | --- |
| Record mode per worktree | Partial | Local observed; no direct-SSH/runtime-owned live target |
| Identity-only diagnostics | Partial | Existing APIs expose host/tab/PTY identities and counts; no epoch/revision/generation/mutation diagnostic envelope |
| A/B live terminal; determine B `workspace.patch` | Code-proven only | Unit test proves hydrated renderer writes; no real B traffic capture |
| Binding loss vs PTY death | Not run | Code path does not kill PTY, but reporter sequence unmeasured |
| Stale file; orphan `openFiles` | Code-proven only | Deterministic builder fallback; no live B reproduction |
| Renderer disconnect/reload + delayed epochs | Ordering flaw code-proven; retained-state symptom unknown | No live crash/reload fault injection; headless merge not exercised |
| Visible A and `orca serve` | Not run | No second host/runtime fixture |

**Exit gate: NOT PASSED.** Do not claim all reported symptoms share the listed causes, and do not begin Slices 2-5 until the remaining live matrix assigns each symptom to an observed protocol path.

## Precise runnable completion matrix

Run each row twice: once with a visible desktop A and once with headless `orca serve` A. Use one direct-SSH-only target, one runtime-owned target, and one deliberately mixed namespace if current configuration permits it.

For every event record only: timestamp, A/B/C client ID, source/target runtime environment ID, durable host owner (`local`/`ssh:<id>`/`runtime:<id>`), renderer window/generation, runtime/publication epoch and revision/version, mutation ID, stable tab IDs and counts by type, PTY IDs/count/connectivity, relay method (`workspace.get`/`workspace.patch`/`workspace.changed`), and preserve/reject reason.

1. **Baseline live terminal**
   - On A create one terminal and record canonical parent tab ID, leaf ID, PTY ID, `terminal list`, and OS/provider process count.
   - Open the same workspace on B without mutating it.
   - Capture whether B sends `workspace.patch`, its namespace/base revision/tab IDs, and whether A's tab binding, runtime leaf, PTY listing, and process remain.
   - Repeat after a benign B store mutation that triggers session persistence.

2. **Direct SSH versus runtime-owned**
   - Repeat baseline separately for direct SSH and Remote Orca Server ownership.
   - Disconnect runtime transport without changing durable ownership; verify classification remains runtime-owned.
   - For a mixed target, verify whether one full replacement contains both partitions. Do not send a destructive test patch against valuable state; use disposable fixtures.

3. **Orphan file origin**
   - On A create `openFiles=[F]` with no unified editor tab using a disposable fixture.
   - Capture A's outbound runtime graph and B's resulting tabs.
   - Separately test a retained old host snapshot with no orphan fallback, so the two origins are distinguishable.
   - Open a B-local file and verify it is absent from B's outbound host projection.

4. **Generic close**
   - Make host snapshot contain F after A's renderer has forgotten F.
   - Close F from B; record request ID, immediate host response, renderer event/ack (currently none), main cached snapshot, and reappearance after client suppression expiry.
   - Repeat for dirty and pinned F without discarding user data.

5. **Renderer lifecycle**
   - Record E1/version N, force renderer reload/crash while main stays alive, delay an E1 frame, publish E2/version 1, then release delayed E1.
   - At each step record graph health, cached files/browsers/terminals, accepted/rejected frame, and companion view.
   - Publish a pre-hydration empty graph and verify whether it removes prior renderer-owned surfaces.

6. **List/subscribe boundary**
   - Add a barrier after inventory capture and before listener registration.
   - Mutate one tab while blocked, then release subscription.
   - Verify whether subscriber receives the mutation; current ordering predicts it is lost.
   - Repeat every boundary for `subscribe` and `subscribeAll`.

7. **Visible/serve comparison**
   - Run steps 1-6 with visible A.
   - Restart from a clean disposable state under `orca serve`, repeat, and compare exact accepted relay/runtime sequences rather than assuming convergence.

8. **#9053 independence**
   - In its own branch/test, keep one saved final terminal tab while provider listing succeeds with zero PTYs.
   - Assert `terminal list` and `worktree ps.liveTerminalCount` are zero.
   - Separately cover listing failure and reattach grace; preserve metadata without calling it live.

## Recommended next action

Build a disposable fault-injection harness that can launch two renderer clients against one host plus a relay observer, with barriers around renderer publication and list/subscription registration. First land only identity-safe diagnostics and characterization fixtures; use their traces to split terminal relay replacement, stale runtime publication, and any newly discovered symptom into separate implementation slices. Any authority-epoch design must explicitly reconcile the existing renderer `publicationEpoch`/`snapshotVersion` contract and the headless-hydrated merge path rather than layering an unrelated epoch beside them. Keep PR #9053 independent.
