# Resource Usage popover hides CPU/Memory for live local PTYs (and mislabels them `· REMOTE`)

## Symptom

In the status-bar **Resource Usage** popover, worktrees show a `· REMOTE` chip and `—` instead of CPU/Memory numbers, even when the user has no SSH targets configured and the underlying PTYs are running on the local machine.

Reproduced against a real session: 4 of 5 visible workspaces in the popup carried `· REMOTE`, and `orca-data.json → sshTargets` was `[]`.

The chip is the loud part. The quiet part is worse: the popover's job is to tell the user which workspace is eating CPU/memory, and for the four affected rows it answers with `—`. Until the user clicks into each terminal pane, the popover is empty for any workspace whose PTYs were spawned by a previous Orca run. So this isn't really a labelling bug — it's a data-coverage bug whose most visible symptom is a wrong label.

## What the chip is supposed to mean

The chip is rendered at the chip render sites in `src/renderer/src/components/status-bar/ResourceUsageStatusSegment.tsx`'s `WorktreeRow` and the per-repo aggregate row:

```tsx
{!worktree.hasLocalSamples && (
  <span className="…">· remote</span>
)}
```

The intent (per `docs/resource-usage-merge-spec.md`) is "this worktree's PTYs run on a remote SSH host, so the local memory collector can't sample them — render `—`." That's a real constraint: the collector deliberately skips SSH PTYs via the `if (!args.connectionId)` gate around the `registerPty` call in `pty.ts`'s `pty:spawn` handler because their process trees aren't visible to the local `ps`/`wmic` sweep.

## What actually triggers it

`hasLocalSamples` is **not** a remote/local signal. It's a "did this worktree show up in the local memory snapshot?" signal — and the snapshot has a narrower scope than the daemon's view of live PTYs.

Concretely, `mergeSnapshotAndSessions` (`src/renderer/src/components/status-bar/mergeSnapshotAndSessions.ts`) unions two sources:

1. **`MemorySnapshot.worktrees`** — produced by `src/main/memory/collector.ts:runSnapshot`, which walks the in-memory `pty-registry`. The registry is written exactly once, in the `pty:spawn` IPC handler in `src/main/ipc/pty.ts`, gated by the `if (!args.connectionId)` check around the `registerPty` call. A worktree appears here iff the **renderer in this Orca process** has called `pty:spawn` for one of its PTYs in this app session. Anything in this list is tagged `hasLocalSamples: true` in step 1 snapshot ingest of `mergeSnapshotAndSessions.ts`.

2. **`pty.listSessions()`** — every alive PTY the daemon tracks, including ones spawned by a previous Orca run that the current renderer hasn't reattached to yet. Step 2 daemon-session merge in `mergeSnapshotAndSessions.ts` adds anything in `listSessions()` that step 1 didn't already cover, with `hasLocalSamples: false`. It also flips `repo.hasRemoteChildren = true`.

A purely local PTY can land in step 2 — and therefore get `· REMOTE` — whenever the daemon knows about it but the renderer's `pty-registry` doesn't.

## Why the registry can be empty for a live local PTY

Daemon-hosted PTYs survive renderer restarts by design (see the orphan-cleanup comment about Daemon-backed sessions surviving renderer restarts in `src/main/ipc/pty.ts`: "Daemon-backed sessions survive renderer restarts… orphan cleanup would kill them"). On warm reattach, the renderer re-binds to existing daemon sessions through `TerminalPane`'s lifecycle, which eventually calls `pty:spawn` with the existing `sessionId`. That call writes the registry entry.

Until that mount happens for a given workspace, the daemon's `listSessions()` returns the PTY but `pty-registry` doesn't have it — so the snapshot omits it, and step 2 of the merge labels it `· REMOTE`.

In `orca terminal list --json` you can see this state directly: PTYs that the renderer hasn't bound get synthetic ids minted by `buildPtyTerminalSummary` in `src/main/runtime/orca-runtime.ts`, which sets `tabId: "pty:${pty.ptyId}"` and `leafId: "pty:${pty.ptyId}"`. PTYs the renderer **has** bound get normal renderer tabIds (UUIDs). In the reproduction the four `· REMOTE` workspaces all had `pty:`-prefixed tabIds; the one non-`REMOTE` workspace in the same popup had a normal UUID tabId.

## Evidence from the live system

- `~/Library/Application Support/Orca/orca-data.json` → `"sshTargets": []`. The user has no SSH targets configured, so no PTY in this Orca can be remote.
- `orca repo list --json` → all 7 repos have local filesystem paths and no `connectionId` field.
- `orca worktree ps --json` → every workspace in the popup reports `hasAttachedPty: true` and `liveTerminalCount > 0`. So the PTYs are alive.
- `orca terminal list --json` → the `· REMOTE`-labelled worktrees have `tabId: "pty:de1c…"` (synthetic). The non-`REMOTE` worktree has `tabId: "7c572b60…"` (renderer UUID).

The `pty:`-prefix vs UUID split lines up exactly with the `· REMOTE` vs no-chip split in the popup.

## Why this is a bug, not just a label nitpick

- It misrepresents the user's setup: they read "remote" as "this is on an SSH host," which is materially false.
- The `—` cells suggest "we can't sample this," when in fact we can — the data is just one IPC away (the daemon already has the pids; or the renderer just hasn't mounted the pane yet, after which the next snapshot covers it).
- It defeats the popover's job: a user wanting to see which local workspace is eating memory gets dashes for any workspace whose terminals haven't been clicked on since launch.

## Proposed fix

Two changes shipping together. The first closes the data gap at the source. The second makes the chip predicate semantically honest so that no future regression turns it back into a "we don't have data" proxy.

### 1. Hydrate `pty-registry` from the daemon on warm boot (coverage fix)

This change is bigger than a single-method edit. Three things have to ship together:

**1a. Wire a daemon-driven boot hydration into the startup path.** We need to call `provider.listSessions()` from a startup hook where `getDaemonProvider()` returns a non-null adapter and the **main-process** `Store` has already been loaded from disk. Both hold by the time `attachMainWindowServices` is called from `src/main/index.ts` — `attachMainWindowServices` is invoked synchronously alongside the BrowserWindow construction, before the renderer process loads. The renderer's store hydration is irrelevant here; everything the boot caller needs (`store.getRepos()`, `listRepoWorktrees`) is main-process work. The natural site for the new call is inside `attach-main-window-services.ts`, alongside the `scheduleHistoryGc` block that already iterates repos and worktrees — see 1b.

**Construct `validWorktreeIds`** the same way `scheduleHistoryGc` does today (in the `scheduleHistoryGc` block in `attach-main-window-services.ts`): `for (const repo of store.getRepos()) { for (const wt of await listRepoWorktrees(repo)) { ids.add(`${repo.id}::${wt.path}`) } }`. This is git I/O — N async invocations, one per repo — but it's the same I/O `scheduleHistoryGc` already pays at +10s; the boot caller can either share the result or pay it again. (`store.getRepos()` returns repos, not worktrees, so there is no synchronous shortcut.)

**1b. Plumb a `repoConnectionIdByWorktreeId` lookup into the call site.** `DaemonPtyAdapter`'s constructor takes only socket/token/protocol/history options — no Store reference, no repo metadata. `SessionInfo` has no `connectionId` either; the daemon doesn't know about repo policy. So the SSH gate cannot live inside the adapter as written. Two choices, both acceptable; pick (B):

  - **(A)** Extend `reconcileOnStartup`'s signature to `(validWorktreeIds, repoConnectionIdByWorktreeId)`. The caller builds the map from `Store.getRepos()` crossed with the worktree → repo lookup the renderer already does in `mergeSnapshotAndSessions.ts`.
  - **(B)** Move the registry-hydration step *out* of the adapter entirely. The caller iterates `SessionInfo[]` from `provider.listSessions()` (fanning out across every adapter so legacy daemons are covered), parses the worktreeId via `parsePtySessionId`, looks up the repo's `connectionId`, and calls `registerPty` itself. Boot-time hydration is read-only with respect to the daemon — it does not invoke `reconcileOnStartup` because a transient `listWorktrees` failure (which returns `[]` and only logs) would otherwise let the reconcile pass kill live sessions. Orphan cleanup remains the responsibility of `reconcileOnStartup`'s existing callers (currently invoked only by tests; production callers can be added later if needed).

  (B) keeps `daemon-pty-adapter.ts` agnostic of repo policy, mirrors the layering of the spawn path (where the `if (!args.connectionId)` gate around the `registerPty` call in `pty.ts`'s `pty:spawn` handler reads `args.connectionId` from IPC and gates `registerPty` itself), and is the layout we'll use.

**1c. Extract a shared `parsePtySessionId` helper.** The `@@` parse used to be open-coded in two places: a loose version in `daemon-pty-adapter.ts`'s `reconcileOnStartup` (returned the full sessionId on no-`@@`) and a stricter version in the parse step of `mergeSnapshotAndSessions.ts` (required both `@@` and `::`). The boot-time hydration would have been a third call site needing to agree, so we unified all three on the strict parser. Add `parsePtySessionId(sessionId): { worktreeId: string | null }` to `src/shared/pty-session-id-format.ts` so the renderer's `mergeSnapshotAndSessions.ts` can import it (renderer code cannot import from `src/main/`). Re-export it from `src/main/daemon/pty-session-id.ts` so existing main-side imports next to `mintPtySessionId` keep working. Use it from all three sites.

**1d. Pid-write ordering.** `registerPty` in `pty-registry.ts` is an unconditional `set()`. If a `pty:spawn` IPC writes `pid: 12345` and the boot pass writes `pid: null` for the same `ptyId` (because the daemon hadn't published the pid yet at `listSessions` time), the row degrades. Mitigation: the boot pass must skip registration when an entry already exists, or merge by preferring a non-null pid. The simpler version — snapshot `listRegisteredPtys()` once before the boot loop and skip any `ptyId` already present — is correct in Node's single-threaded runtime: the loop body contains no `await`, so no `pty:spawn` IPC callback can interleave between the snapshot and any `registerPty` call. The snapshot must be taken AFTER any `await` that precedes the loop (e.g. after the `provider.listSessions()` round-trip) so concurrent `pty:spawn` writes during that RPC are still visible. `pty:spawn` is the authoritative source for in-session writes; the boot pass is only there to cover what spawn missed.

After all of this lands, `MemorySnapshot.worktrees` includes every live local daemon PTY from the first poll onward — no warm-up window, no merge step 2 fallback for the local case. The renderer-side union in `mergeSnapshotAndSessions.ts` step 2 only triggers for genuinely remote sessions, which is what it was supposed to do all along.

### 2. Render `· remote` iff `repo.connectionId != null` (predicate fix)

Thread `repoConnectionIdById` through `MergeContext` in `mergeSnapshotAndSessions.ts` alongside the existing `repoDisplayNameById`. At both chip render sites in `ResourceUsageStatusSegment.tsx`'s `WorktreeRow` and the per-repo aggregate row, gate the chip on `repo.connectionId != null` instead of `!hasLocalSamples`. Apply the same gate to the repo-aggregate's `hasRemoteChildren` so that a repo's "REMOTE" indicator also keys on connectionId rather than inferred remoteness.

No alternate label like `· detached`. If the row's data isn't actually missing for a remote reason, no chip — the absence of a number tells the user enough on its own.

### Why this pair, in this order

The coverage fix alone would make the chip predicate technically correct *most* of the time, because `hasLocalSamples` would converge to `true` for every local PTY within one snapshot tick after boot. But a freshly-spawned local PTY can still land in `pty.listSessions()` before the next snapshot poll — a 2-second window where the predicate would re-mislabel. The predicate should be honestly named on first principles, not because the data happens to converge fast enough to mask it. Both changes are small; ship both.

## Alternatives considered

**Predicate fix only.** Just change the chip predicate, don't touch the registry. Rejected: this only relabels the bug. The popover still shows `—` for every workspace whose terminals haven't been clicked since launch. The user-visible failure (the popover doesn't answer the question it exists to answer) is unchanged.

**Have the collector consult `daemon-pty-adapter.listSessions()` on every snapshot poll.** Rejected. The collector polls every 2 seconds and already runs a non-trivial `enumerateProcesses` sweep; adding an async daemon RPC into the hot path is a real cost. It also entrenches the dual-source pattern — the collector now permanently has two inputs it has to reconcile, instead of treating `pty-registry` as the single source of truth for "what local PTYs exist."

**Single source of truth: collector reads daemon `listSessions()` directly, eliminate `pty-registry`.** Architecturally cleanest but a much larger refactor — in-process `LocalPtyProvider` PTYs (non-daemon path) still need the registry, so it doesn't fully disappear, just its overlap with daemon sessions does. Worth doing as a follow-up; out of scope for this fix.

## Interaction states

| State                                          | Today                                  | After this fix              |
| ---------------------------------------------- | -------------------------------------- | --------------------------- |
| Loading (popover just opened)                  | `—` everywhere until first snapshot    | same (1 tick)               |
| Zero PTYs                                      | "Nothing running right now"            | same                        |
| All local, all renderer-bound                  | numbers                                | numbers                     |
| All local, some not yet pane-mounted (the bug) | `—` + `· REMOTE`                       | numbers                     |
| Mix local + truly remote (SSH)                 | local: numbers; remote: `—` + chip; warm-boot local: bug | local: numbers; remote: `—` + chip |
| All truly remote (SSH)                         | `—` + chip                             | same                        |
| Daemon offline at boot                         | snapshot empty, banner shown           | same — see Failure modes    |
| Snapshot stale (>10s)                          | numbers (last seen)                    | same                        |

## Architecture

### System context

```
                    ┌─────────────────────────────┐
                    │       Renderer (React)      │
                    │  ResourceUsageStatusSegment │
                    │    ↑ snapshot   ↑ sessions  │
                    └──────┬──────────────┬───────┘
                           │ IPC          │ IPC
                           │ memory:get   │ pty:listSessions
                ┌──────────▼──┐    ┌──────▼─────────────┐
                │  collector  │    │  pty.ts handler    │
                │    (main)   │    │  unions providers  │
                │  walks      │    └─┬───────────┬──────┘
                │  registry   │      │           │
                └──────▲──────┘      │           │
                       │ register    │           │
                ┌──────┴──────┐      │           │
                │ pty-registry│◀─────┤   ┌───────▼──────────────┐
                │ (today: only│  spawn   │ daemon-pty-adapter   │
                │  via spawn) │      │   │  listSessions() ──────┼── new write
                │ (after fix: │◀─────┼───┤  (warm boot hydrate)  │
                │  also via   │      │   │                       │
                │  listSessns)│      │   └────────┬──────────────┘
                └─────────────┘      │            │ JSON-RPC
                                ┌────▼────┐       │
                                │ Local   │  ┌────▼─────┐
                                │ Provider│  │  Daemon  │
                                └─────────┘  └──────────┘
```

The asymmetry today: `pty-registry` is downstream of the `pty:spawn` IPC, but daemon sessions can exist without ever touching that IPC (they survive renderer restarts on purpose — see the orphan-cleanup comment about Daemon-backed sessions surviving renderer restarts in `pty.ts`). The collector reads only the registry, so its view is strictly narrower than the daemon's. The renderer then tries to compensate by *also* asking the daemon — but it can only flag presence, not get pids or memory. The renderer-side union in `mergeSnapshotAndSessions` is unique in this codebase: every other main↔renderer surface (tabs, repos, worktrees) follows a single-source pattern. Hydrating the registry from the daemon at boot brings this surface back to the codebase's normal pattern.

### Data flow paths for the chip render

| Path | Today | After fix |
| --- | --- | --- |
| Spawn-in-this-session (happy local) | spawn → registerPty → snapshot has worktree → `hasLocalSamples=true` → no chip | same |
| Truly remote (SSH) | spawn skips registerPty (gated on `connectionId`) → snapshot omits → step 2 of merge picks up from listSessions → chip via `!hasLocalSamples` | spawn skips registerPty → snapshot omits → step 2 picks up → chip via `connectionId != null` (same outcome, honest predicate) |
| Warm-reattach local (the bug) | previous Orca's session alive → registry empty → snapshot omits → step 2 picks up → chip via `!hasLocalSamples` (mislabel) | boot hydration via `provider.listSessions()` registers session → snapshot includes worktree → numbers, no chip |
| Daemon offline at boot | snapshot empty, sessionsError set, banner shown | same — see Failure modes |

## Failure modes

- **Daemon offline at boot.** `provider.listSessions()` rejects when the daemon socket is unreachable. The boot caller wraps the call in `try/catch`, logs, and proceeds — the pre-existing dual-source merge fallback (step 2 in the renderer) covers the gap until the daemon is reachable, exactly as today. No regression.
- **`pid: null` on a `SessionInfo`.** `pty-registry` already accepts `pid: null` entries; the collector's process sampler will skip rows without pids and pick them up on the next snapshot once the pid is published.
- **SSH sessions in `listSessions()`.** The boot-time hydration must apply the same gate as the spawn-time `registerPty` call gated on `if (!args.connectionId)` in `pty.ts`'s `pty:spawn` handler — only sessions whose repo has no `connectionId` get registered. Otherwise we'd start sampling pids for sessions whose process tree isn't on this machine.
- **Concurrent boot + spawn.** If a renderer-side `pty:spawn` races the boot-time hydration, both call `registerPty` for the same `ptyId`. `registerPty` in `pty-registry.ts` is an unconditional `Map.set`, so the second write wins. The two writes are NOT bitwise identical: spawn writes `pid: result.pid ?? null` from node-pty's spawn callback; the boot pass reads `pid` from `SessionInfo` (`pid: number | null`), which the daemon may publish as `null` briefly post-spawn. If the boot pass races a freshly-spawned session whose pid is already known, an unconditional second write would degrade pid to null. Mitigation (see 1d above): the boot pass takes a once-up-front snapshot of `listRegisteredPtys()` before entering the loop and skips any `ptyId` already present — a `pty:spawn` arriving during the boot pass is observed by the once-up-front snapshot if it lands before the loop starts; once the loop is running, single-threaded execution serializes writes naturally because the loop body has no `await`. `pty:spawn` is the authoritative writer for in-session sessions; the boot pass only fills the warm-reattach gap.

## Related issues (out of scope)

- `buildPtyTerminalSummary` in `src/main/runtime/orca-runtime.ts` mints synthetic `pty:`-prefixed tabIds for daemon sessions the renderer hasn't bound yet — visible in `orca terminal list --json`. Same root cause as this bug (main process doesn't know renderer-side state for warm-reattached PTYs), different render path. Track separately; this fix doesn't touch it.
- `docs/resource-usage-merge-spec.md` step 5 enshrines `hasRemoteChildren = true` whenever `hasLocalSamples === false`, which is the false equivalence at the heart of this bug. The spec needs an erratum so the next person to touch this code doesn't re-derive the same predicate. Not edited from this doc.

## Files involved

- `src/main/daemon/daemon-pty-adapter.ts` — `reconcileOnStartup`; the orphan-kill loop. The boot-time hydration no longer calls into `reconcileOnStartup` (see §1b); the adapter itself stays unchanged.
- `src/main/daemon/daemon-pty-router.ts` — `reconcileOnStartup` pass-through across current + legacy adapters; same shape as the adapter call.
- `src/main/daemon/daemon-init.ts` — `getDaemonProvider()` returns the active router/adapter; the boot caller obtains its handle here.
- `src/main/window/attach-main-window-services.ts` — natural site for the new boot-hydration call. Called from `src/main/index.ts` synchronously alongside BrowserWindow construction; the main-process `Store` is already loaded by then (see §1a). Same scope as the existing `scheduleHistoryGc` block, which the new caller can mirror or share for `validWorktreeIds`.
- `src/shared/pty-session-id-format.ts` — home of `parsePtySessionId`, importable by renderer.
- `src/main/daemon/pty-session-id.ts` — re-exports it next to `mintPtySessionId`.
- `src/main/daemon/types.ts` — `SessionInfo`; already exposes the `pid` the registry needs.
- `src/main/memory/pty-registry.ts` — write target. The `registerPty` call from the boot caller skips when the once-up-front `listRegisteredPtys()` snapshot already contains the `ptyId` (see 1d).
- `src/main/ipc/pty.ts` — existing spawn-time `registerPty` call, gated on `!args.connectionId`; the boot-time gate is the symmetric check applied to repo metadata loaded from `Store.getRepos()`.
- `src/main/persistence.ts` — `Store.getRepos()`; source for the boot caller's `repoConnectionIdByWorktreeId` lookup. `connectionId` is set at `addRepo` and immutable thereafter (see Failure modes), so the map is safe to capture once at boot.
- `src/renderer/src/components/status-bar/mergeSnapshotAndSessions.ts` — `MergeContext`; thread `repoConnectionIdById` through alongside the existing `repoDisplayNameById`.
- `src/renderer/src/components/status-bar/ResourceUsageStatusSegment.tsx` — chip render sites in `WorktreeRow` and the per-repo aggregate row; predicate change.
