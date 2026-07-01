# PR #6983 — Stage/CodeRabbit Risk Review & Fixes

PR: `feat(database): in-app Postgres/MySQL client` (stagereview.app/stablyai/orca/pull/6983 → github.com/stablyai/orca/pull/6983)
Scope: reviewed all bot findings on the PR, verified each against current code, fixed the real ones.
Committed as `dc1374e7a fix(database): harden connection lifecycle, update validation, and SQL parsing` (23 files). Working tree clean.

## Where the risks came from
- **stage-review[bot]** posted navigation "chapters" only — no risk findings.
- **coderabbitai[bot]** posted the actual review: 13 inline findings (against commit `2ddbe721e`) + 2 nitpicks.
All 13 + 1 compliance nitpick fixed. Tests: 224 pass across touched files. `typecheck` ✓, switch-exhaustiveness lint ✓, localization catalog parity + coverage ✓.

## Fixes (finding → change)

Majors:
- **Late error from a superseded connection** (`db-connection-manager.ts`) — driver `'error'` was keyed only by id, so a stale pool's error could tear down its reconnect. Bound the handler to the specific `LiveConnection` (identity guard); stale-instance errors ignored. +test.
- **`inFlight` leaked on teardown** (`db-connection-manager.ts`) — cleared in `handleConnectionError`/`disconnect`/`disconnectAll` so a reconnect can't inherit a dead query's backend PID (mis-cancel) or trip the busy guard. +test.
- **Unbounded MySQL validation ping** (`mysql-driver.ts`) — wrapped `SELECT 1` in `raceWithTimeout`; `connectTimeout` only covers the TCP dial.
- **PK column mis-attribution** (`postgres-introspection-queries.ts`) — added `tc.table_name = kcu.table_name` to the PK join (standard-correct; belt-and-suspenders for index-backed PK names).
- **Postgres wraps every statement in a txn** (`postgres-query.ts`) — writable + non-cursorable statements now run in autocommit, so `VACUUM`/`CREATE DATABASE`/`REINDEX CONCURRENTLY` no longer fail "cannot run inside a transaction block". Read-only txn guard and cursor path unchanged. +tests.
- **DB shutdown fire-and-forget on quit** (`index.ts`) — folded `disconnectAll()` into the awaited `Promise.allSettled` teardown so pools close before exit (idempotent on the guarded 2nd will-quit pass).
- **`database:update` unsanitized** (`ipc/database.ts`) — added `sanitizeUpdate` mirroring `sanitizeInput` (coerce strings, validate engine/port, only present fields). +tests.

Minors:
- **Timing-dependent debounce test** (`persistence-db-connections.test.ts`) — replaced fixed `setTimeout(400)` with a bounded poll (no CI race).
- **False "Copied" toast** (`ResultsGrid.tsx`) — await clipboard write; success/`copyFailed` toast on the actual outcome. New `copyFailed` i18n key (5 locales).
- **Memoized failed dynamic import** (`monaco-sql-language.ts`) — reset the cached promise in `.catch` so SQL highlighting can recover after a transient chunk-load failure. +test.
- **`disconnect` leaked stale query state** (`store/slices/database.ts`) — reuse `dropCacheForNonLive` so `dbQueryState` (not just schema cache) is dropped on disconnect.
- **Classifier `sanitize` missed quoted regions** (`sql-statement-classifier.ts`) — single-pass strip of single/double/backtick quoted regions (doubled-quote escapes only). +tests.

Compliance nitpick:
- **Shortcut label** (`QueryWorkspace.tsx`) — `⌘/Ctrl` combined → platform-specific via `{{mod}}` interpolation (`⌘` on Mac, `Ctrl` elsewhere), per AGENTS.md.

## Deliberately NOT done (with reason)
- **Backslash string escapes (`\'`) in the classifier** — reviewer suggested handling them. Rejected: Postgres under `standard_conforming_strings` (default) does NOT treat `\` as an escape, so consuming `\'` as escaped could swallow a real `;` and slip a multi-statement past the read-only guard. Kept the "over-detect, never under-detect" invariant (documented in code). Double-quoted / backtick handling — the safe half — was added.
- **applyDbStatus ↔ subscribe callback duplication** (CodeRabbit nitpick, "low value") — 2 trivial lines; left per KISS.

## Notes / unresolved
- Local `oxlint` (full) fails to load config: `.oxlintrc.json:56` references `unicorn/no-array-fill-with-reference-type`, unknown to the installed oxlint — pre-existing env/version mismatch, unrelated to these changes (no lint config touched). Scoped/switch-exhaustiveness lint runs clean. CI presumably pins a matching oxlint.
- During the review, concurrent activity on the branch committed my fixes (`dc1374e7a`), merged `origin/main` (`cdd246ffc`), and added a separate table-preview feature (`7b5864a4a`); my `store/slices/database.ts` F12 edit landed in `7b5864a4a` (same file, concurrent). All 13 fixes verified present in the current tree.
- Live PG/MySQL integration tests (docker) remain a recommended follow-up to exercise read-only rejection, cursor/stream bounding, cancel, and the new autocommit path end-to-end.
