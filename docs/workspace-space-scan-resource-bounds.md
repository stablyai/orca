# Workspace Space Scan Resource Bounds

## Problem

Resource Manager scans every non-prunable worktree to calculate workspace disk usage. A fleet with
hundreds of worktrees can make Orca and the host unresponsive while the scan is active.

Two independent resource failures are possible:

- macOS and Linux run recursive `du` processes for several worktrees at once. Competing full-tree
  metadata walks can saturate local storage and stall unrelated applications.
- Windows, unsupported `du` variants, timeouts, and filesystem errors use a portable recursive
  walker. The old walker allocated a promise and retained result node for every entry without a
  capacity limit, so a large worktree could exhaust the main or relay process heap.

The July 27 incident occurred with 298 Orca worktrees. Renderer telemetry remained far below its
heap limit, while quitting Orca immediately restored host responsiveness. The installed binary also
contained the uncapped portable fallback.

## Root Cause

`src/main/workspace-space-analysis.ts` admitted up to three worktree scans per repository while
scanning two repositories concurrently. That allowed as many as six local `du` traversals.

Both the desktop portable walker and `src/relay/workspace-space-scan.ts` recursively called
`Promise.all(entries.map(...))`. Filesystem operation limiters capped active `stat` and `readdir`
calls, but they did not cap queued promises, retained paths, directory arrays, or aggregate result
nodes. A failed `du` scan then repeated the same traversal through this higher-memory path.

Shared fixed-worker traversal and capacity primitives already exist, but the active desktop and
relay scanners did not use them.

## Goals

- Keep the host responsive while scanning hundreds of local worktrees.
- Bound portable traversal memory before admitting filesystem entries.
- Preserve size totals, symlink behavior, top-level compaction, partial failures, cancellation, and
  progress reporting.
- Apply equivalent bounds to local, folder-workspace, WSL, and SSH relay paths.
- Preserve the current WSL-aware Git worktree listing and abort signals.

## Non-Goals

- Make a 298-worktree scan finish quickly.
- Change Resource Manager UI, progress copy, deletion rules, or scan persistence.
- Exclude `node_modules`, build output, or other directories from reported size.
- Change Git worktree discovery or cleanup behavior.
- Introduce polling, caching, or background automatic scans.

## Design

### Local disk admission

Create one scan-wide limiter for local worktree traversal. Repository discovery and remote scans can
remain concurrent, but every local worktree must acquire the single local slot before invoking
`du` or the portable walker.

The slot is global to one Resource Manager scan, not per repository. This changes the maximum local
full-tree traversal count from six to one. Cancellation rejects queued admissions and stops the
active child process through the existing `AbortSignal`.

### Remote fallback admission

The desktop-side request-by-request SSH fallback runs its traversal inside the desktop main
process, so its budget is charged against Orca's heap rather than the remote host. Repository and
worktree concurrency alone would let six of these traversals hold six independent budgets at once.
A second scan-wide limiter admits at most two, capping aggregate admission at 2 × 64 MiB instead of
6 × 64 MiB. Bulk relay scans stay outside this limiter: their traversal memory lives on the remote
host, one hard capacity per request.

### Fixed-worker portable traversal

Use `scanWorkspaceSpaceEntryTree` for desktop local fallback, desktop remote-provider fallback, and
relay fallback scans. The traversal:

- owns only the configured number of live entry jobs;
- preserves source order and aggregate sizes;
- uses iterative directory frames instead of recursive promise fanout;
- stops on cancellation and removes its abort listener;
- treats unreadable or disappearing entries as partial failures;
- does not follow symlink targets.

Top-level `du` result processing uses `mapWithConcurrency` so unusually wide workspace roots do not
allocate one live operation per entry.

### Capacity admission

Every portable entry is admitted through `WorkspaceSpaceScanBudget` before retention:

- maximum entries in any one directory listing: 100,000;
- maximum estimated live scan state per worktree traversal: 64 MiB.

The entry cap is per listing rather than per traversal because only a single directory's width is
fixed by directory shape. A traversal-wide entry counter is charged by every worker holding a
listing at once, so its verdict scales with the configured concurrency: at 48 workers, 48 × 2,100
files (100,848 entries) was rejected while 100 × 1,500 (150,100 entries, 50% more) was admitted.
Aggregate live retention stays bounded by the 64 MiB byte cap, which all concurrent listings share.

The retained-byte estimate includes entry name UTF-16 storage plus conservative per-entry object
overhead, and each listing's parent path once. The parent path is charged per listing rather than
per entry because a listing's entries all share a single parent-path string; charging it per entry
multiplied it by the directory's width, so the 64 MiB cap tracked checkout depth instead of live
heap and rejected the layouts above once the worktree path passed ~58 characters. These are
admission limits, not post-allocation observations.

The budget measures what the traversal is holding **right now**, not what it has ever seen. A
directory listing is charged when admitted and released once every one of its entries has been
dispatched, so the caps bound the widest concurrent frontier rather than total tree size. This
distinction decides real workspaces: a cumulative counter charged an ordinary 76,788-entry Orca
worktree 61.2 MiB of its 64 MiB cap — 4% headroom, and tipping over purely because a longer branch
name lengthens every absolute path. The same worktree peaks between 4 MiB and 8 MiB of live state.

Neither cap may depend on where a user checks out their worktrees, so the estimate charges each
absolute path once per listing rather than once per entry. A live cap depends only on directory
shape, so it rejects genuinely pathological layouts (one directory holding six figures of entries)
and nothing else.

Top-level directory enumeration for the `du` path uses the same budget. A capacity error must not
fall through into the portable walker, because that would repeat an already rejected traversal.

### Failure behavior

- Desktop local scan: return an unavailable worktree row with the capacity error. `classifyError`
  maps `WorkspaceSpaceScanCapacityError` to `unavailable` rather than `error`, because the workspace
  is intact and readable, just too large to size safely. The Resource Manager renders that row as
  "Unavailable" instead of "Failed".
- SSH relay scan: reject the bulk scan; the desktop provider converts it to an unavailable row.
- Generic `du` failure: use the bounded portable fallback.
- Cancellation: propagate the scan-cancelled error rather than converting it to a row failure.
- Missing or unreadable entries below the capacity limit: preserve existing partial-result
  behavior.

### Platform and workspace parity

- macOS/Linux: one local `du` at a time; bounded Node fallback.
- Windows: one local bounded Node traversal at a time.
- WSL: retain `getLocalProjectWorktreeGitOptions` and its selected distro for worktree discovery;
  UNC/native filesystem traversal uses the same local admission and capacity bounds.
- SSH: prefer the bulk relay scan; both the relay and the request-by-request compatibility fallback
  use the shared capacity model.
- Folder workspaces: the synthetic main worktree passes through the same local limiter and scanner.

## Data Flow

1. Resource Manager starts one deduplicated scan and creates an abort controller.
2. Repository workers list worktrees with existing host-specific Git options and the scan signal.
3. Remote worktrees continue through provider concurrency. Local worktrees wait for the scan-wide
   local slot.
4. POSIX local or relay scans try `du`.
5. Top-level entries are admitted against the scan budget and projected with bounded concurrency.
6. If `du` fails generically, the fixed-worker portable traversal scans within the same limits.
7. Capacity failures become unavailable rows; successful results keep existing compaction and
   progress behavior.

## Alternatives Considered

### Only reduce `du` concurrency

This protects local storage but leaves Windows, SSH compatibility fallback, and failed `du` scans
capable of unbounded heap growth.

### Only add traversal capacity limits

This prevents OOM but still permits several recursive `du` processes to compete for local storage,
which does not address the observed whole-host stall.

### Remove the portable fallback

This would fail Windows scans and POSIX environments where `du -d` is unavailable or errors during
active filesystem churn.

### Skip dependency and build directories

This would make Resource Manager under-report the directories users most often want to reclaim.

## Measurement and Performance Budget

The deterministic regression measurements are:

- peak simultaneous local `du` calls across repositories: exactly one;
- peak simultaneous desktop-side SSH fallback traversals across repositories: at most two;
- portable traversal live entry jobs: no more than its configured worker count;
- portable entries in any one directory listing: at most 100,000;
- estimated live portable state: at most 64 MiB per worktree; an ordinary 76,788-entry worktree
  peaks between 4 MiB and 8 MiB;
- progress and final row counts remain unchanged for scans below the limits.

A follow-up diagnostic span should record strategy (`du` or portable), worktree duration, fallback
reason, admitted entry count, estimated retained bytes, and peak local scan concurrency. It must
record counts and identifiers rather than raw paths or directory trees.

## Test Plan

- Desktop integration: force the portable path over its entry budget and assert an unavailable row.
- Relay integration: force the portable path over its entry budget and assert a capacity failure on
  both the Windows/portable and POSIX `du` entry points.
- Remote fallback concurrency: hold six SSH fallback traversals across two repositories and assert
  no more than two run at once.
- Concurrency: start local worktrees from two repositories, hold the first `du`, and assert the
  second does not start until the first completes.
- Shared traversal: verify worker peak, source order, exact-limit success, over-limit failure, deep
  trees, partial failures, and cancellation cleanup.
- Existing desktop coverage: local results, symlinks, progress, cancellation, WSL routing, SSH bulk
  scans, disconnected SSH, `du` timeout fallback, and IPC deduplication.
- Run `pnpm run typecheck` and `pnpm run build`.

## Rollout

1. Connect the shared fixed-worker traversal and capacity budget to desktop and relay scanners.
2. Add the scan-wide single local traversal slot.
3. Add focused capacity and concurrency regression tests.
4. Ship without a migration or feature flag; behavior below the limits is unchanged.
5. Monitor capacity failures and scan duration before considering a higher local concurrency.

## Risks

- Scanning hundreds of worktrees takes longer because local work is serialized. The feature already
  streams progress and allows users to leave the page, and host responsiveness takes priority over
  scan throughput.
- A legitimate worktree above the capacity limit is reported unavailable instead of partially
  sized. Failing closed avoids presenting an incomplete size as safe deletion evidence. With a live
  cap this now requires a pathological directory rather than merely a large repository.
- Because the local slot is acquired inside the per-repository worker pool, a local worktree waiting
  on the slot still occupies one of the six in-flight scan slots. On fleets mixing local and SSH
  repositories this can delay remote repositories behind serialized local work, even though remote
  scans never contend for the local disk.
- Remote hosts can still process concurrent worktrees, but each relay request has an independent
  hard capacity and remote concurrency does not contend with the user's local disk.

## Validation

- Focused tests: 36 passed across desktop analysis, IPC, relay, shared traversal, scan budget, and
  concurrency primitives.
- TypeScript: all node, CLI, and web projects passed.
- Production build: relay targets, CLI, Electron, renderer, web projection, and macOS native
  components completed successfully.
- No live 298-worktree rescan is required for correctness validation; the concurrency and capacity
  properties are deterministic tests.
