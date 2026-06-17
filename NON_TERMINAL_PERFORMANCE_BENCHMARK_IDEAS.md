# Non-terminal performance benchmark ideas

This note intentionally avoids Terminal/PTY files because several terminal model PRs are in flight. Each candidate below should be benchmarked before changing product behavior.

## 1. Browser/webview memory lifecycle

**Why this is worth measuring:** a user reported renderer memory around 1.2GB. Browser tabs and webviews are a plausible non-terminal source because they can retain renderer processes, page state, screenshots, session history, and listeners after close/switch flows.

**Benchmark shape:** create a scripted Electron benchmark that opens, switches, and closes 30, 60, and 100 browser tabs across one or more workspaces. Record renderer RSS, JS heap, webContents/webview count, detached DOM node count if available, and memory after forced GC/settle windows.

**Success signal:** after closing tabs and waiting for cleanup, memory and webContents count should return near baseline rather than growing with every cycle.

**Likely fix area if confirmed:** browser pane lifecycle, webview destruction, global listener cleanup, tab/session history caps, and cached screenshot/metadata release.

## 2. Sidebar and worktree-list render churn

**Why this is worth measuring:** `WorktreeList`, worktree cards, status indicators, repo grouping, and filters sit on broad store state. Large repo/worktree counts can turn small store updates into visible render churn even when the terminal model is untouched.

**Benchmark shape:** seed synthetic state with 10 repos × 100 worktrees, then measure worktree switch, filter toggle, repo expand/collapse, metadata update, and unread/status changes. Capture React commit time, component render counts, long tasks, and interaction latency.

**Success signal:** localized updates should not re-render the full tree, and filter toggles should stay under a predictable commit-time budget at 1,000 worktrees.

**Likely fix area if confirmed:** narrower Zustand selectors, memoized grouping, stable keys, targeted list updates, and possible virtualization if visible row count is much smaller than total row count.

## 3. Git/worktree refresh subprocess churn

**Why this is worth measuring:** worktree refresh can multiply git subprocesses by repo/worktree count. On large projects, idle refreshes or event cascades may create main-process load without any terminal involvement.

**Benchmark shape:** create repos/worktrees at scale, then run a 60-second idle window plus controlled file/git events. Count git subprocesses by command/cwd, total subprocess wall time, repeated failures, and main-process event-loop delay.

**Success signal:** idle should not repeatedly spawn the same git probes, and refresh after localized changes should avoid full repo × worktree fanout where possible.

**Likely fix area if confirmed:** inflight dedupe, stable-negative caching, event coalescing, targeted refreshes, and backoff for repeated git failures.

## 4. Persistence and store payload bloat

**Why this is worth measuring:** persisted UI/session state can accumulate with workspaces, browser/editor tabs, metadata, history, and feature state. Even if writes are debounced, large stringify/write cycles can create periodic renderer or main-process stalls.

**Benchmark shape:** generate scaled app state with many repos, worktrees, browser tabs, editor tabs, task metadata, and UI records. Measure serialized byte size by top-level field, `JSON.stringify` time, write time, and frequency of persistence calls during common interactions.

**Success signal:** high-frequency interactions should not stringify large unchanged slices, and payload size should have explicit caps or pruning rules for history-like fields.

**Likely fix area if confirmed:** prune persisted history, normalize large maps, compare slices by reference before serialization, and split hot ephemeral state from durable state.

## 5. Resource Manager and workspace-space scans

**Why this is worth measuring:** Resource Manager can trigger filesystem scans and process/resource attribution. This is directly related to the user-visible resource tab and can be expensive on large workspace trees.

**Benchmark shape:** create many workspaces with nested directories and large ignored/generated folders, then open Resource Manager and trigger refreshes. Count `du`/filesystem scan time, cancellation effectiveness, concurrency, UI long tasks, and whether stale scans update the UI after navigation.

**Success signal:** scans should be cancellable, bounded, and coalesced; opening the panel should not create sustained CPU or UI jank on large workspace sets.

**Likely fix area if confirmed:** scan concurrency limits, cache invalidation by workspace mtime/token, stale-result dropping, and cheaper initial summaries before deep scans.

## Suggested first benchmark

Start with **browser/webview memory lifecycle**. It is the closest non-terminal hypothesis for the 1.2GB renderer report, has a clean measurable signal, and should not conflict with terminal model changes.

A good first pass would produce a table like:

| Scenario | Baseline memory | Peak memory | Settled memory | webContents count | Notes |
| --- | ---: | ---: | ---: | ---: | --- |
| Open/close 30 browser tabs | TBD | TBD | TBD | TBD | TBD |
| Open/close 60 browser tabs | TBD | TBD | TBD | TBD | TBD |
| Open/close 100 browser tabs | TBD | TBD | TBD | TBD | TBD |
| Switch 100 times across 10 tabs | TBD | TBD | TBD | TBD | TBD |

## Guardrails

- Do not touch Terminal/PTY implementation while these terminal PRs are in flight.
- Measure before optimizing.
- Keep benchmark harnesses repeatable and runnable in CI or locally from one command.
- Prefer count-based proof: subprocess count, webContents count, render count, serialized bytes, or settled memory delta.
- Separate product fixes from benchmark harness work so the before/after numbers stay trustworthy.
