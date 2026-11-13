# STA-14464: session search purge cost, root cause and design (step 1)

Base: origin/main `75823710787`. Model: Opus 5.5 (claude-opus-5-5). Machine: M4 MacBook Air, 32 GB, shared QA host (load average 5 to 30 during runs; see the `load` field in the raw JSON).

## TL;DR

- **The issue as filed is already fixed on main.** #40134 (`4fa7b00f53f`, merged 2026-11-09) bounds the tool-row purge with a persisted high-water mark (`tool_purge_scanned_rowid`) plus a floor trigger. It ships in v1.4.256, v1.4.257 and v1.4.258, so Jinjing's 1.4.258 build already has it. Measured on that path: steady state is 0.03 to 0.04 ms at 1M and 3M rows. Only the first pass on an unmarked DB is O(N): 372 ms at 1M rows, 2.97 s at 3M rows, once per DB.
- **The field span `aiVault.search.purge` is mostly something else.** Two code paths share that name:
  1. the tool-row purge's per-page delete (`traceSessionSearch('purge', …)` in `storage/session-search-tool-purge.ts`), which is synchronous and small;
  2. the worker op `purge` (`worker/session-search-worker-entry.ts:240`, `withSpan('aiVault.search.purge', () => store.purgeOlderThan(cutoff))`), which runs on every full sweep (`indexing/session-search-pass.ts:69`).
- **Real root cause:** the orphan probe in `drainOrphanedMessages` (`storage/session-search-retention-delete.ts`):
  ```sql
  SELECT session_row_id FROM messages WHERE session_row_id NOT IN (SELECT id FROM sessions) LIMIT 1
  ```
  The plan is `SCAN messages USING COVERING INDEX messages_session`. When no orphan exists, it reads the whole index, O(messages). `purgeOlderThan` calls `scheduleOrphanDrain()`, whose microtask runs the first probe synchronously before `withSpan` records its end, so the probe's cost lands inside the purge span (purge span ≈ probe time in the numbers below). The drain also reruns the probe after **every** orphaned session it finishes. Deleting K sessions (retention, or transcript replacement in `session-search-index-writer.ts`, which deletes the previous session row) therefore costs about K full index scans.
- **Thread:** the search writer **worker thread** (`worker_threads`), not the Electron main thread. It is still a perf bug: it holds the writer lane, delays other writer ops and status deltas, and burns CPU on every full sweep and every replacement commit.

## Before numbers (real production code via `bench.ts` / `drain-bench.ts`, warm OS cache)

| DB  | messages / sessions | size     | control point read | orphan probe (median / max)              | `aiVault.search.purge` span (median / max) | tool purge first / steady |
| --- | ------------------- | -------- | ------------------ | ---------------------------------------- | ------------------------------------------ | ------------------------- |
| m1  | 1,000,000 / 5,000   | 577 MB   | 0.01 ms            | 40.2 / 49.5 ms (cold connection: 446 ms) | 44 / 100 ms                                | 372 ms / 0.04 ms          |
| m3  | 3,000,000 / 15,000  | 1,730 MB | 0.01 ms            | 61.2 / 120.9 ms                          | 61 / 62 ms                                 | 2,965 ms / 0.03 ms        |

Orphan drain after deleting K sessions (m1, 200 messages per session, `m1-drain.json`):

| K                     | drain time     | rows drained |
| --------------------- | -------------- | ------------ |
| 0                     | 35.5 ms        | 0            |
| 1 (one replacement)   | 57.7 ms        | 200          |
| 20                    | 1,019.7 ms     | 4,000        |
| 100 (retention batch) | **3,954.9 ms** | 20,000       |

The K=100 result matches the field's 4.2 s maximum. The 46 s total over 73 calls (about 630 ms average) is also consistent with a DB in the low millions of rows, plus colder page cache or concurrent drains on the user's machine. **Not verified against the field DB:** I had no access to Jinjing's trace or `ai-vault/session-search.sqlite`; see HANDOVER.md.

## Design (recommended): persistent orphan queue, so drain work is O(orphaned rows) and idle work is O(1)

1. Add `orphaned_sessions(id INTEGER PRIMARY KEY)` plus a trigger `AFTER DELETE ON sessions BEGIN INSERT OR IGNORE INTO orphaned_sessions VALUES (OLD.id); END`. Put both next to the other derived objects (`session-search-query-schema.ts` pattern). The queue entry commits in the same transaction as the session delete, so crash recovery stays resumable. The trigger lives in the DB, so deletes by older builds sharing schema v8 are queued too.
2. Backfill exactly once. When the trigger is missing, create it inside `BEGIN IMMEDIATE` and seed the queue with `INSERT OR IGNORE INTO orphaned_sessions SELECT DISTINCT session_row_id FROM messages WHERE session_row_id NOT IN (SELECT id FROM sessions)`. That is one full scan per DB lifetime, not per writer open or sweep.
3. `drainOrphanedMessages` reads its next id from `SELECT id FROM orphaned_sessions LIMIT 1` instead of the probe. It deletes in batches of 256 as today, and removes the queue row in the same transaction as the batch that drains its last messages.
4. Correctness: `sessions.id` is `AUTOINCREMENT` and never reused, so a queued id can never refer to a live session, and no stale rows can reappear. Rows an older build drains first make our pass delete 0 and pop the entry. The existing generation and maintenance accounting (`recordIndexMaintenance`, `search_generation_orphan_reclaim`) is unchanged.
5. Optional, separate change: give the tool-purge page span its own name (`purge.tool`), so traces stop conflating the two paths. That is a trace rename, not a fix.

Expected after: an idle purge or drain does an O(1) queue read (0.01 ms class), and K deletes cost O(K × rows per session) of real deletes instead of K full scans. This is not user-visible, so no UX review is needed.

## Alternatives considered

- **Index-seek probe** (recursive-CTE loose index scan over `messages_session`, no schema change; `probe-alt.ts`). Measured 7.2 ms against 40 ms at m1 and 15.1 ms against 61 ms at m3. It is only about 4 to 5x better, because its cost scales with the number of sessions, and it still touches every index leaf when cold. It does not remove the K-scans-per-drain multiplier. Rejected as insufficient, though it is the smallest diff if reviewers prefer no schema objects.
- **In-memory "dirty" flag** (probe only after we delete sessions): misses foreign writers and crash leftovers unless it still probes on every open, and keeps K full scans per drain. Rejected.
- **Pass the deleted session ids directly to the drain** (in-memory): crash or foreign-writer orphans need a full probe anyway. The persisted queue is the durable version of the same idea.

## What would disprove this

- A field trace in which most `aiVault.search.purge` spans are the tool-purge page child (look for a `parentSpanId` pointing at a tool-purge parent rather than at a worker `purge` op), or in which long purge spans show no matching drain. Then the cost sits in the tool purge (first pass on an unmarked DB) or in expired-file deletes, not in the probe.
- Running `EXPLAIN QUERY PLAN` and probe timing on Jinjing's actual DB and finding the probe cheap there.
