# Steady-state worktree rescan: Git-admin fingerprint gate

## Status

Adopted for the main-process worktree resolution cache
(`OrcaRuntimeService.listRepoWorktreesForResolution`). It keeps the existing
30-second freshness contract for externally created, removed, moved, locked, and
re-checked-out worktrees while removing the `git worktree list` subprocess that
previously ran for every registered repository every 30 seconds.

## Context

A production trace (10 registered repositories, 3 h 27 min) recorded 4,272
`git worktree` invocations and 8,663 total Git subprocesses. The invocations
arrived in full-fleet sweeps roughly every 30.5 s — one sweep per repository per
`WORKTREE_SCAN_CACHE_TTL_MS`.

### What actually expires the cache

The originating report assumed some specific terminal/status/orchestration
request was invalidating the 30-second cache. That is not what happens, and the
distinction changes the fix:

- `resolvedWorktreeCache` (the whole-fleet snapshot) has a **1-second** TTL
  (`RESOLVED_WORKTREE_CACHE_TTL_MS`). Any caller polling faster than 1 Hz
  recomputes the snapshot.
- `computeResolvedWorktrees` fans out over **every** registered repo
  (`src/main/runtime/orca-runtime.ts`), calling
  `listRepoWorktreesForResolution` per repo.
- That per-repo call is backed by `worktreeScanCache` with a **30-second** TTL.
  When it expires, the next poll shells out.

So no request "expires" the 30-second cache. It expires on wall-clock time, and
whichever poller arrives first afterwards pays a full-fleet `git worktree list`
fan-out. The many high-frequency callers — `listTerminals` without a selector,
`showTerminal`, `getWorktreePs`, `listManagedWorktrees`,
`resolveWorktreeSelector`, orchestration authority refresh — only determine
_who_ pays, not _how often_. Steady-state subprocess volume is therefore
`repos / 30 s`, independent of poll rate, which is exactly the observed
~1 sweep / 30.5 s.

The in-Orca mutation surface is already event-driven: create, remove, rename,
folder-rename, sparse edits, repo add/update/remove, SSH reconnect, and
mixed-version remote invalidation all call
`invalidateWorktreeScanCacheForRepo` / `invalidateResolvedWorktreeCache`
(≈40 call sites). The 30-second TTL exists for exactly one reason: discovering
worktree changes made **outside** Orca (`git worktree add/remove/move/prune`,
`git checkout` in another worktree, `rm -rf` of a worktree directory).

That is a filesystem question, and the filesystem can answer it without a
subprocess.

## Goals

- Remove the periodic all-repository `git worktree list` fan-out in steady
  state.
- Preserve the current ≈30 s discovery latency for externally created, removed,
  moved, pruned, locked/unlocked, and re-checked-out worktrees.
- Keep a bounded reconciliation so anything the cheap probe cannot observe still
  converges.
- Change nothing for SSH repos, WSL-routed repos, folder workspaces, bare repos,
  or hosts where the probe cannot resolve Git's admin layout.
- Fail open: any probe error must behave exactly like today (run the real scan).

## Non-goals

- Changing `RESOLVED_WORKTREE_CACHE_TTL_MS` or the whole-fleet snapshot shape.
- Changing the renderer-facing `worktrees:list` / `worktrees:listAll` IPC scan
  cache in `src/main/ipc/worktrees.ts` (separate 5 s cache, invalidated by
  `registerWorktreeChangeInvalidator`, not a polling source in the trace).
- Scoping `resolveWorktreeSelector` to a single repository. See
  "Rejected alternatives".
- Adding a filesystem watcher per repository.
- Any wire/RPC/persisted-schema change.

## Design

Introduce a cheap, subprocess-free **Git worktree admin fingerprint** for a
local repository, and consult it before re-running a scan whose TTL has expired.

### Fingerprint inputs

`readRepoWorktreeAdminFingerprint(repoPath)` in
`src/main/runtime/repo-worktree-admin-fingerprint.ts` resolves the repo's Git
common directory without a subprocess (read `.git`; if it is a `gitdir:` file,
follow it and then its `commondir`; if `.git` is absent, treat `repoPath` as a
bare gitdir), then records:

| Input                                              | External change it catches                                    |
| -------------------------------------------------- | ------------------------------------------------------------- |
| sorted entry names of `<commonDir>/worktrees`      | `worktree add`, `worktree remove`, `worktree prune`           |
| existence of `repoPath`                            | main checkout deleted                                         |
| `<commonDir>/packed-refs` mtime + size             | a tip moved while its loose ref is packed away                |
| `<commonDir>/reftable` mtime + size                | a tip moved under the reftable backend                        |
| per checkout: `HEAD` contents                      | branch switch, detach (the detached oid is in HEAD itself)    |
| per checkout: contents of the ref HEAD names       | a plain `git commit`, `reset`, or `fetch` that moves the tip  |
| per entry: `gitdir` contents                       | `worktree move`, `worktree repair`                            |
| per entry: `locked` presence                       | `worktree lock` / `unlock`                                    |
| per entry: existence of the path named by `gitdir` | a worktree directory deleted with `rm -rf` (flips `prunable`) |

"per checkout" covers the main worktree and each linked worktree. Reading the
ref HEAD names is what makes an ordinary commit visible: committing rewrites
`refs/heads/<branch>` and leaves `HEAD` untouched, but moves the oid
`git worktree list --porcelain` prints. A symref target is only followed when it
is a relative path under `refs/`, so a hand-edited `HEAD` cannot steer the probe
outside the ref store.

Every input is a `stat`, `readdir`, or small `readFile` on an already-hot inode,
and the fingerprint depends on nothing but the repo path — no prior scan result
is threaded in. Per-repo fan-out is capped at 8 concurrent linked-worktree
probes, mirroring `SPARSE_CHECKOUT_DETECTION_CONCURRENCY`. A 10-repo fleet with
10 worktrees each costs a few hundred filesystem calls per 30 s window versus 10
process spawns; the spawns dominate by orders of magnitude, and process-table
churn was the reported symptom.

The fingerprint is a NUL-delimited string; any read failure yields `null`, which
the caller treats as "cannot prove unchanged".

### Cache decision

`listRepoWorktreesForResolution` gains one branch on the expired-TTL path:

```text
cached entry exists, same generation + runtimeKey, TTL expired
  └─ probe eligible? (no connectionId, no wslDistro, fingerprint recorded)
       ├─ no  → real scan (today's behaviour)
       └─ yes → read fingerprint now
            ├─ null or different              → real scan
            ├─ equal, last real scan < 5 min  → extend TTL, no subprocess
            └─ equal, last real scan ≥ 5 min  → real scan (bounded reconcile)
```

`WORKTREE_SCAN_ADMIN_RECONCILE_INTERVAL_MS` is 5 min, matching the existing
`WORKTREE_SCAN_AGENT_SCRATCH_TTL_MS` precedent. A cached result whose scan
failed (`ok: false`) is never extended, so a transient Git failure still retries
on the 30 s TTL.

### Git version compatibility

Every path the probe reads is part of Git's on-disk layout well before the 2.25
baseline in [`git-compatibility.md`](./git-compatibility.md): `.git` as a
directory or `gitdir:` file, `commondir`, `worktrees/<name>/{HEAD,gitdir,locked}`,
`packed-refs`, and loose `refs/`. `reftable` arrived in 2.45; on older Git it
simply stats as missing, which is a stable value and therefore harmless. No new
Git command is introduced — this change only skips one.

Agent-scratch repos already carry a 5-minute scan TTL
(`WORKTREE_SCAN_AGENT_SCRATCH_TTL_MS`), which equals the reconciliation
interval, so the gate never fires for them and their behaviour is unchanged.

### Ordering

The fingerprint stored with a scan result is captured **before** the scan runs.
A mutation landing while the scan is in flight therefore leaves the stored
fingerprint stale-by-construction, so the next probe sees a difference and
rescans. Capturing after the scan would let that mutation be masked forever.

### Interaction with existing invalidation

Untouched. `invalidateWorktreeScanCacheForRepo` deletes the entry (fingerprint
included) and bumps the generation, so every event-driven path still forces a
real scan on the next read. The fingerprint only ever _extends_ an entry that
the TTL alone would have refreshed.

## Freshness budget

| Change                                                                | Before            | After             |
| --------------------------------------------------------------------- | ----------------- | ----------------- |
| Orca-initiated create/remove/rename/sparse/repo edit                  | immediate (event) | immediate (event) |
| SSH reconnect / provider generation bump                              | immediate (event) | immediate (event) |
| External `worktree add/remove/move/prune/lock`                        | ≤ 30 s            | ≤ 30 s            |
| External `git checkout` / `commit` / `reset` in any worktree          | ≤ 30 s            | ≤ 30 s            |
| External `rm -rf <worktree>`                                          | ≤ 30 s            | ≤ 30 s            |
| External sparse-checkout pattern edit                                 | ≤ 30 s            | ≤ 5 min           |
| Packed/reftable tip moved within one mtime tick at an equal file size | ≤ 30 s            | ≤ 5 min           |
| SSH / WSL repos, folder workspaces                                    | unchanged         | unchanged         |

The two regressions are bounded by the reconciliation interval and are both
changes Orca does not make itself.

### Main-thread cost

Both the scan and the probe are asynchronous, so neither "runs on the main
thread" in the naive sense — but they are not equally free there. Measured on
macOS with a 1 ms interval sampling event-loop lag while each ran 30 times
against a repo with 20 linked worktrees:

|                     | wall per call | main-thread stall per call | worst single stall |
| ------------------- | ------------- | -------------------------- | ------------------ |
| `git worktree list` | 18.66 ms      | 2.69 ms                    | 3.02 ms            |
| fingerprint probe   | 1.66 ms       | 0.01 ms                    | 0.04 ms            |

`fs/promises` dispatches to libuv's threadpool, so ~99 % of the probe's latency
is off-thread. Spawning Git does not: `uv_spawn`, fd and pipe setup, and stdout
collection and decoding are real synchronous main-process work. Ten repos
refreshing together therefore cost ≈27 ms of event-loop stall per sweep before
this change and ≈0.1 ms after — this reduces main-thread pressure rather than
adding to it, which is why moving either side onto a worker thread would not
help.

### Residual risk

A repo registered at a UNC path (`\\wsl$\...`) but executed by the local Windows
Git runtime is still probed, because it is not WSL-routed from Orca's point of
view. The probe is correct there and strictly cheaper than the subprocess it
replaces, but its filesystem calls cross the 9p boundary like the existing
sparse-checkout probes already do.

## Measured effect

`src/main/runtime/worktree-scan-admin-fingerprint-gate.test.ts` drives the
reported steady state — 10 idle local repos, a caller polling at 1 Hz for 30
simulated minutes — and counts `git worktree list` invocations:

|                          | `git worktree list` per 30 min | per hour |
| ------------------------ | ------------------------------ | -------- |
| TTL only (before)        | 600                            | 1,200    |
| fingerprint gate (after) | 60                             | 120      |

A 90 % reduction, with the remainder being the bounded reconciliation. Repos
with genuine external activity keep rescanning at the 30 s cadence because the
fingerprint flips.

Extrapolating to the original trace's shape (10 repos, 3 h 27 min): 4,272
`git worktree` invocations would become ≈427.

## Rejected alternatives

**Raise `WORKTREE_SCAN_CACHE_TTL_MS` to 5 min.** One line, same subprocess
reduction, but it degrades _every_ external-change latency to 5 min, including
the common "I ran `git worktree add` in a terminal" case. The fingerprint buys
the same reduction without that regression.

**Per-repo `fs.watch` on `<commonDir>/worktrees`.** Lower latency, but adds
persistent watcher handles per repo, inherits recursive-watch platform
differences, and would need its own dormancy/rearm story. The existing watcher
infrastructure is scoped to workspace files; extending it to Git admin dirs is a
larger change with a worse risk profile for the same steady-state win.

**Scope `resolveWorktreeSelector` to the owning repository.** The original brief
asks for this. `listTerminals` already avoids the fan-out for explicit worktree
ids via `buildResolvedWorktreeFromId` +
`listKnownResolvedWorktreesForExplicitTarget`. Extending that to
`resolveWorktreeSelector` means splitting the highest-fan-in method in the
runtime (38 call sites) and rebuilding lineage projection for a repo subset —
material regression risk. Once the fingerprint gate lands, the remaining
fan-out cost for a targeted call is a batch of stats, not a subprocess, so the
gain no longer justifies the risk. Tracked as follow-up, not in this change.

## Test plan

`src/main/runtime/repo-worktree-admin-fingerprint.test.ts` (real temp dirs, real
`git` binary — a mocked filesystem would only restate the assumptions):

- stable across repeated reads with no change
- changes after `worktree add`, `worktree remove`, `worktree move`,
  `worktree lock`, `checkout` in a linked worktree, `checkout` in the main
  worktree, a commit in either, and `rm -rf` of a worktree directory
- still tracks a tip whose loose ref has been packed away by `git pack-refs`
- a linked worktree path and the main repo path produce the same fingerprint
- a bare repo resolves through its own gitdir and still tracks `worktree add`
- `null` for a non-Git directory and for a missing path

`src/main/runtime/worktree-scan-admin-fingerprint-gate.test.ts`:

- unchanged fingerprint suppresses the rescan past the 30 s TTL and re-arms it
- changed fingerprint rescans at the 30 s TTL
- the 5-minute reconciliation forces a rescan while the fingerprint is unchanged
- `notifyBranchRenamed` (event invalidation) still forces an immediate rescan
- a `null` fingerprint (probe failure) falls back to scanning
- SSH repos never consult the probe
- a failed scan is never extended
- concurrent callers share one probe and one scan
- the 1 Hz / 10-repo workload measurement above
