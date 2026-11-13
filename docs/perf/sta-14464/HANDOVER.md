# STA-14464 handover (to Brennan)

## Status

Step 1 (root cause, design, before numbers) is done; see `DESIGN.md`. There is **no implementation** on this branch and no PR; the design has not been through D1 review.

## Key findings

- The issue as filed (tool-row purge restarting at rowid 0) is already fixed by #40134, which is in v1.4.256 and later, including the field build 1.4.258.
- The field cost is the orphan-drain probe (`NOT IN (SELECT id FROM sessions)`, a full scan of `messages_session`), which runs on every `purge` op and full sweep, on every replacement commit, and once per orphaned session during a drain. Deleting 100 sessions takes 3.95 s at 1M rows. It runs on the search writer worker thread, not Electron main.

## Open questions

1. No access to Jinjing's `main.trace.ndjson` or `ai-vault/session-search.sqlite`. Ask for the row and session counts (`SELECT count(*) FROM messages; SELECT count(*) FROM sessions;`), and check whether the long `aiVault.search.purge` spans are worker `purge` ops or tool-purge page children (compare `parentSpanId` and timing).
2. Reviewer preference: the persistent orphan queue (recommended, O(1) idle, one-time backfill scan) or the zero-schema index-seek probe (about 4 to 5x faster, keeps K scans per drain).
3. Should the tool-purge page span be renamed (`purge.tool`) so traces stop conflating the two paths?

## Not measured (blockers if a reviewer needs them)

- OS-cold-cache numbers: `sudo purge` is unavailable on this shared host. A cold SQLite connection on a warm OS cache gave a 446 ms probe at 1M rows.
- A clean no-load control: the host is shared, with load average 5 to 30. In-process point reads (0.01 ms) were used as the control.
- Numbers for the drain at 3M rows.

## Next steps

1. Get D1 design review of `DESIGN.md`.
2. Implement the queue in `storage/session-search-retention-delete.ts` and the derived-schema file, with a backfill guarded by trigger presence under `BEGIN IMMEDIATE`.
3. Re-run `bench.ts measure` and `drain-bench.ts` before and after on the same synthetic DBs (populate with `pnpm exec tsx docs/perf/sta-14464/bench.ts populate <db> 1000000 5000`; `drain-bench.ts` and `probe-alt.ts` import via `../../../src`, so run them from this directory depth).
4. Add one test that fails on revert: after a session delete, the drain removes its messages without the probe, and the queue empties.
