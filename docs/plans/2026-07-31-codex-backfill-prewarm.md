# Codex Backfill Prewarm — State-First Startup Ordering + Pane Indexing UX (#11828 continuation)

> **For agentic workers:** This plan is executed task-by-task by the
> workflow's execute stage: a fresh implementer per task, with a spec +
> quality review after each task. Steps use checkbox (`- [ ]`) syntax
> for tracking.

**Goal:** Make the already-shipped #11828 fix (background codex state-DB prewarm +
pane-side backfill-error toast) actually run in the reporter's exact scenario, by
deferring the short-budget startup trust-grant codex until the session index is
complete, and by gating fresh codex panes behind an "Indexing Codex session
history…" state instead of launching them into a guaranteed failure.

**Architecture:** Three moves. (1) **State-first startup ordering (main):** before
any code path spawns the 10s-budget trust-grant `codex app-server` against the real
`~/.codex`, do a cheap read-only check of `backfill_state` in that home's newest
`state_<N>.sqlite`; when the index is pending, park the real-home hook lane in a new
non-latching `'pending-index'` state instead of spawning a codex that is doomed to
time out and latch the lane `'unavailable'` (which today silently disables the
migration scheduler and therefore the prewarm — the exact deadlock the previous E2E
proved). (2) **Retry after prewarm (main):** when the scheduler-chained prewarm
resolves, re-run the deferred trust grant and re-evaluate the lane; genuine
(non-backfill) grant failures keep today's `'unavailable'` semantics. (3) **Pane
gating UX (renderer):** a fresh local codex pane asks main (new IPC channel) whether
its target home's backfill is pending; while pending it shows a spinner overlay
("Indexing Codex session history…", with a cheap progress hint from the backfill
cursor) and auto-spawns codex when the index completes. The existing output-scanning
detector + amber toast stays as the fallback net for races at the completion
boundary.

**Tech Stack:** Electron main process (TypeScript, Node), `node:sqlite` via the
existing `SyncDatabase` adapter, Electron IPC (`ipcMain.handle` / `webContents.send`
/ preload `contextBridge`), React renderer, Vitest.

## Global Constraints

- PR targets `main` (the workflow controller opens it after this branch is done).
- Branch: `codex-backfill-prewarm`, worktree
  `/home/dan/code/orca/.orca/worktrees/orca/codex-indexing-issues-11828/.worktrees/codex-backfill-prewarm`,
  fork point `e058429e1` (v1.4.162). All commands below run from that worktree root.
- Cross-platform (macOS / Linux / Windows): paths via `path.join` only; no
  hardcoded POSIX-only paths in product code (AGENTS.md).
- SSH / remote / folder-workspace use cases: the pane gate applies ONLY to fresh
  **local** spawns; remote-runtime and SSH panes must fail open (spawn immediately)
  because their codex home is on the remote host and main's reader is local-fs only.
- Comments are concise WHY-only. No `max-lines` lint disables — new logic goes in
  focused sibling modules, not inline growth of `pty-connection.ts` (8,872 lines).
- No vague `util`/`helper` filenames.
- Renderer strings rendered as JSX go through `translate(key, englishFallback)` from
  `@/i18n/i18n` with keys under `auto.components.terminal.pane.<Component>.<leaf>`;
  after adding strings run `pnpm run sync:localization-catalog` (lint gates on
  catalog parity). Never call `translate()` at module top level.
- All read access to real codex state DBs outside tests is read-only
  (`readonly: true` sqlite); #11830 forbids adding writes/repairs.
- Known pre-existing `pnpm test` failures on this machine (proven at merge base
  `e058429e1`, NOT to be fixed here): 7 failures across
  `src/main/startup/configure-process.test.ts`, `src/main/daemon/pty-subprocess.test.ts`,
  `src/main/providers/local-pty-provider.test.ts`,
  `src/main/agent-hooks/managed-hook-timeout.test.ts` (plus 2 load-flakes that pass
  in isolation). Branch-owned tests must pass 100%.
- E2E safety: NEVER write to the user's real `~/.codex` or
  `~/.local/share/orca/codex-runtime-home` (both currently `status=complete`;
  read-only `mode=ro` sqlite checks only). Sandboxed E2E uses `cp -a` real copies
  (never hardlinks) into a `mktemp -d` HOME and is fully deleted afterward.

---

## Background for implementers (zero-context summary)

**Already on this branch (tasks 1–7 of the previous plan — do not redo):**
- `src/main/codex/codex-state-db.ts` — read-only backfill status reader
  (`readCodexStateDbBackfillStatus(home)`, `findNewestCodexStateDbPath`,
  `countCodexSessionFilesUpTo`).
- `src/main/codex/codex-state-db-prewarm.ts` — dual-home prewarm supervisor
  (`startCodexStateDbPrewarmInBackground`): spawns a headless
  `codex app-server` with `CODEX_HOME=<home>` and babysits it until
  `backfill_state.status = 'complete'` (poll 5s, fast-exit budget 5×10s, 60-min
  deadline). Targets the system home (`~/.codex`) first, then the managed home.
- `src/main/codex/codex-session-migration-scheduler.ts` — chains
  backfill → index-heal → prewarm; runs on a 15s startup timer and on
  host-default account selection; `requestRun()` silently no-ops when
  `isEligible()` is false.
- `src/renderer/src/components/terminal-pane/codex-backfill-error-detector.ts` +
  `TerminalErrorToast.tsx` — pane-output scanner for codex's
  `timed out waiting for state db backfill` line, surfaced as an amber
  informational toast (`CODEX_BACKFILL_INDEXING_NOTICE`).

**The proven blocker (previous run's E2E, sandboxed 15 GB unindexed home):** at
startup `ensureRealHomeCodexHookState` → `installRealHomeCodexHook`
(`src/main/codex/codex-real-home-hook-install.ts`) spawns a trust-grant
`codex app-server` with a 10s budget (`NATIVE_GRANT_TIMEOUT_MS`,
`src/main/codex/codex-trust-grant-host.ts:20`). Against an unindexed large home
that codex itself hits the #11828 backfill wait and times out
(`CodexAppServerTimeoutError`, collapsed to `{lane:'fallback', reason:'error'}`).
The failure latches the module lane `'unavailable'`
(`codex-real-home-hook-install.ts:219-223`);
`isRealHomeCodexHookLaneUsable()` (`:55-56`, `currentLane !== 'unavailable'`) goes
false; `runtime-home-service.ts:446-447` `isHostSystemDefaultRealHome() =
selected && realHomeLaneGate()` goes false; the scheduler's `isEligible()`
(`src/main/index.ts:2084`) goes false — so the prewarm NEVER runs, and the killed
trust-grant codex leaves a stale `'running'` lease in `backfill_state`.

**Adjudicated design decision (implement exactly this):** check backfill state
BEFORE spawning the trust-grant codex; if pending, defer into `'pending-index'`
(non-latching, scheduler stays eligible); let the scheduler + prewarm run (the
prewarm already spawns on a stale `'running'` lease — codex adopts idle indexes;
stale leases expire ≤15 min — add an explicit unit test); on prewarm completion
re-run the trust grant; gate fresh codex panes on the same pending check with an
indexing overlay and auto-start.

**"Pending" definition (one refinement, mirrored from the prewarm's own spawn
gate):** the grant codex is only doomed when the backfill would outlive its 10s
budget, i.e. when an index run is already tracked as unfinished, or when there is
no index yet AND the session history is large. So: `incomplete` → pending;
`missing`/`not-tracked` → pending only when the home has ≥ 100 rollout files
(the prewarm's `PREWARM_MIN_SESSION_FILES` threshold — below it, codex indexes
within its own 30s startup wait and the prewarm leg itself is a `not-needed`
no-op that could never clear a deferral); `unreadable` → NOT pending (fail open,
keep today's behavior; #11830 territory); `complete` → not pending. This keeps
fresh-install behavior (empty `~/.codex`) unchanged.

---

## File Structure

| File | Task | Responsibility |
|---|---|---|
| `src/main/codex/codex-state-db.ts` (modify) | 1 | + `lastWatermark` on the `incomplete` variant; + `isCodexBackfillIndexPending()`; + `BACKFILL_PENDING_MIN_SESSION_FILES` |
| `src/main/codex/codex-state-db-prewarm.ts` (modify) | 1 | `PREWARM_MIN_SESSION_FILES` re-exported from the shared constant (DRY) |
| `src/main/codex/codex-real-home-hook-install.ts` (modify) | 2, 3 | `'pending-index'` lane + defer-before-grant; `retryRealHomeCodexHookAfterIndex()` |
| `src/main/index.ts` (modify) | 3, 4 | wrap `startStateDbPrewarm` to retry the deferred grant + broadcast status |
| `src/shared/codex-backfill-status-types.ts` (create) | 4 | `CodexBackfillGateStatus` shared payload type |
| `src/main/ipc/codex-backfill-status.ts` (create) | 4 | `codexBackfill:status` handler, `codexBackfill:statusChanged` broadcast, home resolution |
| `src/main/ipc/register-core-handlers.ts` (modify) | 4 | register the new handler |
| `src/preload/index.ts`, `src/preload/api-types.ts`, `src/renderer/src/web/web-preload-api.ts` (modify) | 4 | `window.api.codexBackfill` (invoke + subscription + web stub) |
| `src/renderer/src/components/terminal-pane/codex-backfill-spawn-gate.ts` (create) | 5 | renderer-side wait logic (query + subscribe + repoll, fail-open) |
| `src/renderer/src/components/terminal-pane/pty-connection.ts` (modify) | 5 | defer fresh local codex spawns behind the gate in `runDeferredConnect` |
| `src/renderer/src/components/terminal-pane/pty-connection-types.ts` (modify) | 5 | `onCodexIndexingStateRef` dep |
| `src/renderer/src/components/terminal-pane/CodexIndexingOverlay.tsx` (create) | 6 | spinner/status overlay + progress formatting |
| `src/renderer/src/components/terminal-pane/TerminalPane.tsx` (modify) | 6 | indexing state map + ref handler + portal render |
| `src/renderer/src/i18n/locales/*.json` (modify, generated) | 6 | catalog entries via `pnpm run sync:localization-catalog` |
| Tests (colocated `*.test.ts` / `*.test.tsx`) | 1–6 | per task below |

---

### Task 1: Backfill pending-check + progress cursor in `codex-state-db.ts`

**Files:**
- Modify: `src/main/codex/codex-state-db.ts`
- Modify: `src/main/codex/codex-state-db-prewarm.ts` (constant re-export only)
- Test: `src/main/codex/codex-state-db.test.ts`

**Interfaces:**
- Consumes: existing exports of the same module
  (`findNewestCodexStateDbPath(codexHomePath: string): string | null`,
  `readCodexStateDbBackfillStatus(codexHomePath: string): CodexStateDbBackfillStatus`,
  `countCodexSessionFilesUpTo(sessionsRoot: string, limit: number): number`).
- Produces (later tasks rely on these exact shapes):
  - `CodexStateDbBackfillStatus`'s `incomplete` variant becomes
    `{ kind: 'incomplete'; stateDbPath: string; status: string; lastWatermark: string | null }`.
  - `export const BACKFILL_PENDING_MIN_SESSION_FILES = 100`
  - `export function isCodexBackfillIndexPending(codexHomePath: string): boolean`
  - `codex-state-db-prewarm.ts` keeps exporting `PREWARM_MIN_SESSION_FILES` (same
    value, now aliased to the shared constant) so its existing tests keep passing.

- [ ] **Step 1: Write the failing tests**

Extend `src/main/codex/codex-state-db.test.ts`. This file uses REAL sqlite DBs in
a tmpdir (no mocks) — reuse its existing DB-creation helper if one exists; the
schema it creates for `backfill_state` is
`(id INTEGER PRIMARY KEY CHECK (id = 1), status TEXT NOT NULL, last_watermark TEXT, last_success_at INTEGER, updated_at INTEGER NOT NULL)`.
Add:

```ts
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import SyncDatabase from '../sqlite/sync-database'
import {
  BACKFILL_PENDING_MIN_SESSION_FILES,
  isCodexBackfillIndexPending,
  readCodexStateDbBackfillStatus
} from './codex-state-db'

// Reuse the file's existing tmp-home setup; `home` below is a fresh tmpdir per test.

function writeStateDb(home: string, status: string, lastWatermark: string | null): void {
  const db = new SyncDatabase(join(home, 'state_5.sqlite'))
  db.exec(
    'CREATE TABLE backfill_state (id INTEGER PRIMARY KEY CHECK (id = 1), status TEXT NOT NULL, last_watermark TEXT, last_success_at INTEGER, updated_at INTEGER NOT NULL)'
  )
  db.prepare(
    'INSERT INTO backfill_state (id, status, last_watermark, last_success_at, updated_at) VALUES (1, ?, ?, NULL, 0)'
  ).run(status, lastWatermark)
  db.close()
}

function seedSessionFiles(home: string, count: number): void {
  const dir = join(home, 'sessions', '2026', '07', '01')
  mkdirSync(dir, { recursive: true })
  for (let i = 0; i < count; i++) {
    writeFileSync(join(dir, `rollout-${i}.jsonl`), '{}\n')
  }
}

it('exposes the backfill cursor on incomplete status', () => {
  writeStateDb(home, 'running', 'sessions/2026/07/02/rollout-x.jsonl')
  const status = readCodexStateDbBackfillStatus(home)
  expect(status).toEqual({
    kind: 'incomplete',
    stateDbPath: join(home, 'state_5.sqlite'),
    status: 'running',
    lastWatermark: 'sessions/2026/07/02/rollout-x.jsonl'
  })
})

it('reports null cursor when last_watermark is NULL', () => {
  writeStateDb(home, 'pending', null)
  const status = readCodexStateDbBackfillStatus(home)
  expect(status).toMatchObject({ kind: 'incomplete', lastWatermark: null })
})

it('pending: true for any incomplete status regardless of history size', () => {
  writeStateDb(home, 'running', null)
  expect(isCodexBackfillIndexPending(home)).toBe(true)
})

it('pending: false for complete', () => {
  writeStateDb(home, 'complete', null)
  expect(isCodexBackfillIndexPending(home)).toBe(false)
})

it('pending: true for a missing state db over a large history', () => {
  seedSessionFiles(home, BACKFILL_PENDING_MIN_SESSION_FILES)
  expect(isCodexBackfillIndexPending(home)).toBe(true)
})

it('pending: false for a missing state db over a small history', () => {
  seedSessionFiles(home, BACKFILL_PENDING_MIN_SESSION_FILES - 1)
  expect(isCodexBackfillIndexPending(home)).toBe(false)
})

it('pending: false (fail open) when the state db is unreadable', () => {
  writeFileSync(join(home, 'state_5.sqlite'), 'not a database')
  seedSessionFiles(home, BACKFILL_PENDING_MIN_SESSION_FILES)
  expect(isCodexBackfillIndexPending(home)).toBe(false)
})
```

Also update any existing `incomplete`-variant assertions in this file to include
`lastWatermark` (add the field to expected objects, or switch to `toMatchObject`).

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `pnpm exec vitest run src/main/codex/codex-state-db.test.ts --config config/vitest.config.ts`
(if the test file's top comment prescribes a different repro command, use that).
Expected: new tests FAIL (`isCodexBackfillIndexPending` not exported;
`lastWatermark` missing).

- [ ] **Step 3: Implement**

In `src/main/codex/codex-state-db.ts`:

```ts
export type CodexStateDbBackfillStatus =
  | { kind: 'complete'; stateDbPath: string }
  | { kind: 'incomplete'; stateDbPath: string; status: string; lastWatermark: string | null }
  | { kind: 'missing' }
  | { kind: 'not-tracked'; stateDbPath: string }
  | { kind: 'unreadable'; stateDbPath: string; error: string }
```

In `readCodexStateDbBackfillStatus`, widen the SELECT and the return:

```ts
    const row = db
      .prepare('SELECT status, last_watermark FROM backfill_state WHERE id = 1')
      .get() as { status?: unknown; last_watermark?: unknown } | undefined
    if (!row || typeof row.status !== 'string') {
      return { kind: 'not-tracked', stateDbPath }
    }
    return row.status === 'complete'
      ? { kind: 'complete', stateDbPath }
      : {
          kind: 'incomplete',
          stateDbPath,
          status: row.status,
          // Why: the backfill cursor (a sessions/... rollout path) is the only cheap
          // progress signal codex exposes; panes show it while they wait (#11828).
          lastWatermark: typeof row.last_watermark === 'string' ? row.last_watermark : null
        }
```

Append:

```ts
// Why 100: mirrors the prewarm's spawn gate — below it codex indexes inside its own
// 30s startup wait, so neither the trust grant nor a pane needs to be deferred.
export const BACKFILL_PENDING_MIN_SESSION_FILES = 100

/**
 * True when launching codex against this home would hit the #11828 backfill wait:
 * an unfinished index run is tracked, or no index exists yet over a large history.
 * Unreadable DBs report false — deferral must never be the thing that hides #11830.
 */
export function isCodexBackfillIndexPending(codexHomePath: string): boolean {
  const status = readCodexStateDbBackfillStatus(codexHomePath)
  if (status.kind === 'incomplete') {
    return true
  }
  if (status.kind === 'missing' || status.kind === 'not-tracked') {
    return (
      countCodexSessionFilesUpTo(
        join(codexHomePath, 'sessions'),
        BACKFILL_PENDING_MIN_SESSION_FILES
      ) >= BACKFILL_PENDING_MIN_SESSION_FILES
    )
  }
  return false
}
```

In `src/main/codex/codex-state-db-prewarm.ts`, replace the literal
`export const PREWARM_MIN_SESSION_FILES = 100` with:

```ts
import { BACKFILL_PENDING_MIN_SESSION_FILES } from './codex-state-db'
// Why alias: the trust-grant deferral and the prewarm must agree on what "large
// enough to stall codex" means, or one can defer forever waiting on the other.
export const PREWARM_MIN_SESSION_FILES = BACKFILL_PENDING_MIN_SESSION_FILES
```

(The prewarm already imports from `./codex-state-db`; keep imports merged.)
If the `incomplete`-variant change breaks compilation anywhere else, the fix is
mechanical: those sites only read `kind`/`status`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm exec vitest run src/main/codex/codex-state-db.test.ts src/main/codex/codex-state-db-prewarm.test.ts --config config/vitest.config.ts`
Expected: PASS (both files — the prewarm suite proves the alias kept behavior).
Also run: `pnpm typecheck` — expected exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/main/codex/codex-state-db.ts src/main/codex/codex-state-db.test.ts src/main/codex/codex-state-db-prewarm.ts
git commit -m "feat(codex): expose backfill cursor and pending-index check from state db reader (#11828)"
```

---

### Task 2: Defer the trust grant behind the index — `'pending-index'` lane

**Files:**
- Modify: `src/main/codex/codex-real-home-hook-install.ts`
- Test: `src/main/codex/codex-real-home-hook-install.test.ts`

**Interfaces:**
- Consumes: `isCodexBackfillIndexPending(codexHomePath: string): boolean` (Task 1);
  module-internal `getSystemCodexHomePath()` (already imported from
  `./codex-home-paths`); existing module state `currentLane`, `installRetryAfterMs`.
- Produces:
  - `export type RealHomeCodexHookLane = 'pending' | 'pending-index' | 'installed' | 'unavailable' | 'removed'`
  - `ensureRealHomeCodexHookState(...)` returns `'pending-index'` (and spawns no
    grant codex, mutates no user files) while the system home's backfill is pending
    and the lane is not already `'installed'`.
  - `isRealHomeCodexHookLaneUsable()` stays `currentLane !== 'unavailable'` —
    `'pending-index'` is usable by construction (scheduler stays eligible; panes
    keep routing to the real home; that is the point).
  - Exact deferral log line (Task 8's E2E greps for it):
    `[codex-real-home-hooks] deferring trust grant until codex session index completes`

- [ ] **Step 1: Write the failing tests**

In `src/main/codex/codex-real-home-hook-install.test.ts`. The suite already mocks
`node:os` `homedir` → tmpdir and the whole `./codex-hook-trust-grant` module
(`grantMock`); `_internals.setLaneForTesting('pending')` runs in `beforeEach`.
Add a hoisted mock for the pending check, defaulting to `false` so every existing
test is unaffected:

```ts
const { pendingMock } = vi.hoisted(() => ({ pendingMock: vi.fn<() => boolean>() }))

vi.mock('./codex-state-db', () => ({
  isCodexBackfillIndexPending: pendingMock
}))
```

In the existing `beforeEach`, add `pendingMock.mockReturnValue(false)`.
New tests:

```ts
import { existsSync } from 'node:fs'
import { isRealHomeCodexHookLaneUsable } from './codex-real-home-hook-install'

describe('backfill deferral (#11828)', () => {
  it('defers the grant while the system home backfill is pending', () => {
    pendingMock.mockReturnValue(true)
    grantSucceeds()

    const lane = ensureRealHomeCodexHookState({ hooksEnabled: true, userDataPath: userDataDir })

    expect(lane).toBe('pending-index')
    expect(grantMock).not.toHaveBeenCalled()
    // Why: deferral must be side-effect free — no half-installed hook entry.
    expect(existsSync(getRealHooksJsonPath())).toBe(false)
    expect(pendingMock).toHaveBeenCalledWith(join(fakeHomeDir, '.codex'))
  })

  it('keeps the lane usable (scheduler-eligible) while pending-index', () => {
    pendingMock.mockReturnValue(true)
    ensureRealHomeCodexHookState({ hooksEnabled: true, userDataPath: userDataDir })
    expect(isRealHomeCodexHookLaneUsable()).toBe(true)
  })

  it('grants normally once the backfill completes', () => {
    pendingMock.mockReturnValue(true)
    grantSucceeds()
    ensureRealHomeCodexHookState({ hooksEnabled: true, userDataPath: userDataDir })

    pendingMock.mockReturnValue(false)
    const lane = ensureRealHomeCodexHookState({ hooksEnabled: true, userDataPath: userDataDir })

    expect(lane).toBe('installed')
    expect(grantMock).toHaveBeenCalledTimes(1)
  })

  it('does not defer an already-installed lane', () => {
    // Why: an installed lane holds a valid grant ledger; repeat ensures skip the
    // RPC and spawn nothing, so there is no doomed codex to avoid.
    grantSucceeds()
    ensureRealHomeCodexHookState({ hooksEnabled: true, userDataPath: userDataDir })
    pendingMock.mockReturnValue(true)

    const lane = ensureRealHomeCodexHookState({ hooksEnabled: true, userDataPath: userDataDir })

    expect(lane).toBe('installed')
  })

  it('still sweeps on opt-out while pending-index', () => {
    pendingMock.mockReturnValue(true)
    ensureRealHomeCodexHookState({ hooksEnabled: true, userDataPath: userDataDir })

    const lane = ensureRealHomeCodexHookState({ hooksEnabled: false, userDataPath: userDataDir })

    expect(lane).toBe('removed')
  })
})
```

(Adapt helper names — `grantSucceeds`, `getRealHooksJsonPath`, `fakeHomeDir`,
`userDataDir` — to the file's existing helpers; they exist verbatim today.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm exec vitest run src/main/codex/codex-real-home-hook-install.test.ts --config config/vitest.config.ts`
Expected: new tests FAIL (`'pending-index'` not a lane value; grant still spawns).
Existing tests must still PASS (the `pendingMock` default keeps them on today's path).

- [ ] **Step 3: Implement**

In `src/main/codex/codex-real-home-hook-install.ts`:

1. Import the check: `import { isCodexBackfillIndexPending } from './codex-state-db'`.
2. Extend the union and its doc comment (at `:41`):

```ts
/**
 * ...existing lane docs...
 * - 'pending-index': the target home's codex session index is not complete, so the
 *   10s grant codex would die in the #11828 backfill wait. Non-latching: routing
 *   and the migration scheduler treat it as usable; the grant re-runs after the
 *   prewarm finishes the index.
 */
export type RealHomeCodexHookLane =
  | 'pending'
  | 'pending-index'
  | 'installed'
  | 'unavailable'
  | 'removed'
```

3. In `ensureRealHomeCodexHookState` (`:92`), insert the deferral as the FIRST
   check, before the `'unavailable'` cooldown gate:

```ts
  // Why: #11828 — against an unindexed large home the 10s grant codex hits the
  // backfill wait and dies, and its failure used to latch 'unavailable', which
  // silently disabled the very scheduler/prewarm that would finish the index.
  // Skip when already installed: a valid grant ledger spawns nothing anyway.
  if (
    args.hooksEnabled &&
    currentLane !== 'installed' &&
    isCodexBackfillIndexPending(getSystemCodexHomePath())
  ) {
    if (currentLane !== 'pending-index') {
      console.info(
        '[codex-real-home-hooks] deferring trust grant until codex session index completes'
      )
    }
    currentLane = 'pending-index'
    return currentLane
  }
```

No other changes: `isRealHomeCodexHookLaneUsable()` already returns true for any
non-`'unavailable'` lane; the `installRetryAfterMs` cooldown only consults
`currentLane === 'unavailable'` so `'pending-index'` bypasses it; the three
genuine-failure `return 'unavailable'` sites (`:131`, `:137`, catch at `:110`) and
the grant-failure latch (`:219-223`) are untouched — genuine failures keep today's
semantics.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm exec vitest run src/main/codex/codex-real-home-hook-install.test.ts --config config/vitest.config.ts`
Expected: PASS (all, including pre-existing tests). Also `pnpm typecheck` → exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/main/codex/codex-real-home-hook-install.ts src/main/codex/codex-real-home-hook-install.test.ts
git commit -m "fix(codex): defer real-home trust grant while the session index is pending (#11828)"
```

---

### Task 3: Re-run the deferred grant when the prewarm completes (+ stale-lease proof)

**Files:**
- Modify: `src/main/codex/codex-real-home-hook-install.ts` (one new export)
- Modify: `src/main/index.ts` (`startStateDbPrewarm` wiring at `~:2092`)
- Test: `src/main/codex/codex-real-home-hook-install.test.ts`
- Test: `src/main/codex/codex-state-db-prewarm.test.ts` (stale-lease case)

**Interfaces:**
- Consumes: `ensureRealHomeCodexHookState`, `'pending-index'` lane (Task 2);
  `startCodexStateDbPrewarmInBackground(options, systemCodexHomePathOverride?):
  Promise<CodexStateDbPrewarmSummary[] | null>`; in `index.ts` scope: `store`,
  `app.getPath('userData')`, `isAgentStatusHooksEnabled` (all already used at
  `index.ts:2503-2510`).
- Produces:
  - `export function retryRealHomeCodexHookAfterIndex(args: { hooksEnabled: boolean; userDataPath: string }): RealHomeCodexHookLane`
    — no-op (returns current lane) unless the lane is `'pending-index'`.
  - `index.ts` scheduler arg becomes a closure that re-runs the grant after every
    prewarm resolution (Task 4 extends the same closure with a broadcast).

- [ ] **Step 1: Write the failing tests**

In `codex-real-home-hook-install.test.ts`:

```ts
import { retryRealHomeCodexHookAfterIndex } from './codex-real-home-hook-install'

describe('retryRealHomeCodexHookAfterIndex', () => {
  it('re-runs the grant only from pending-index', () => {
    pendingMock.mockReturnValue(true)
    ensureRealHomeCodexHookState({ hooksEnabled: true, userDataPath: userDataDir })
    pendingMock.mockReturnValue(false)
    grantSucceeds()

    const lane = retryRealHomeCodexHookAfterIndex({ hooksEnabled: true, userDataPath: userDataDir })

    expect(lane).toBe('installed')
    expect(grantMock).toHaveBeenCalledTimes(1)
  })

  it('is a no-op when the lane is not pending-index', () => {
    _internals.setLaneForTesting('unavailable')

    const lane = retryRealHomeCodexHookAfterIndex({ hooksEnabled: true, userDataPath: userDataDir })

    expect(lane).toBe('unavailable')
    expect(grantMock).not.toHaveBeenCalled()
  })

  it('keeps unavailable semantics for a genuine failure on retry', () => {
    pendingMock.mockReturnValue(true)
    ensureRealHomeCodexHookState({ hooksEnabled: true, userDataPath: userDataDir })
    pendingMock.mockReturnValue(false)
    grantUnavailable()

    const lane = retryRealHomeCodexHookAfterIndex({ hooksEnabled: true, userDataPath: userDataDir })

    expect(lane).toBe('unavailable')
  })
})
```

In `codex-state-db-prewarm.test.ts` — the explicit stale-lease proof the design
decision demands. Follow the file's existing `createDeps` DI pattern
(`readBackfillStatus`, `countSessionFiles`, fake children, fake timers):

```ts
it('spawns and supervises past a stale running lease left by a killed codex (#11828)', async () => {
  // Why: the previous E2E proved a killed 10s trust-grant codex leaves
  // backfill_state = 'running'; the prewarm must treat that as incomplete and
  // spawn anyway (codex adopts idle indexes; stale leases expire <=15 min).
  const statuses: CodexStateDbBackfillStatus[] = [
    { kind: 'incomplete', stateDbPath: '/x/state_5.sqlite', status: 'running', lastWatermark: null },
    { kind: 'incomplete', stateDbPath: '/x/state_5.sqlite', status: 'running', lastWatermark: null },
    { kind: 'complete', stateDbPath: '/x/state_5.sqlite' }
  ]
  const readBackfillStatus = vi.fn(() => statuses[Math.min(readBackfillStatus.mock.calls.length - 1, statuses.length - 1)])
  const { deps, spawnProcess } = createDeps({ readBackfillStatus })

  const summaryPromise = runCodexStateDbPrewarm('/x', {}, deps)
  await advanceUntilResolved(summaryPromise) // use the file's existing fake-timer advance helper

  const summary = await summaryPromise
  expect(spawnProcess).toHaveBeenCalledTimes(1)
  expect(summary.outcome).toBe('completed')
})
```

(Adapt the status-sequencing and timer-advance mechanics to the file's existing
helpers — several tests there already sequence `readBackfillStatus` returns; mirror
the closest one. The assertion that matters: `status: 'running'` → spawn happens →
outcome `completed`.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm exec vitest run src/main/codex/codex-real-home-hook-install.test.ts src/main/codex/codex-state-db-prewarm.test.ts --config config/vitest.config.ts`
Expected: retry tests FAIL (export missing). The stale-lease test may already PASS
(the prewarm treats any `incomplete` as spawn-worthy today) — that is fine; it
pins the behavior the design decision depends on. Note the observed result.

- [ ] **Step 3: Implement**

In `codex-real-home-hook-install.ts`, after `ensureRealHomeCodexHookState`:

```ts
/**
 * Re-runs a trust grant that Task-2 deferral parked behind the codex session
 * index (#11828). No-op for every other lane; a genuine grant failure on the
 * retry latches 'unavailable' exactly like a startup failure would.
 */
export function retryRealHomeCodexHookAfterIndex(args: {
  hooksEnabled: boolean
  userDataPath: string
}): RealHomeCodexHookLane {
  if (currentLane !== 'pending-index') {
    return currentLane
  }
  return ensureRealHomeCodexHookState(args)
}
```

In `src/main/index.ts`: add `retryRealHomeCodexHookAfterIndex` to the existing
import from `./codex/codex-real-home-hook-install` (`:191-193`), and replace the
scheduler arg `startStateDbPrewarm: startCodexStateDbPrewarmInBackground` (`:2092`)
with:

```ts
    // Why: #11828 — a trust grant deferred behind the session index must run as
    // soon as the prewarm finishes, not wait minutes for the next pane launch.
    startStateDbPrewarm: (options, override) =>
      startCodexStateDbPrewarmInBackground(options, override).then((summaries) => {
        retryRealHomeCodexHookAfterIndex({
          hooksEnabled: isAgentStatusHooksEnabled(store!.getSettings()),
          userDataPath: app.getPath('userData')
        })
        return summaries
      }),
```

(The closure's shape still matches the scheduler's
`MigrationRun = (options, systemCodexHomePathOverride?) => Promise<unknown>`.
Retrying unconditionally on resolve is safe: `retryRealHomeCodexHookAfterIndex`
no-ops off-lane, and if the prewarm gave up while still pending, the ensure call
re-defers to `'pending-index'`.)

- [ ] **Step 4: Run tests + typecheck**

Run: `pnpm exec vitest run src/main/codex/codex-real-home-hook-install.test.ts src/main/codex/codex-state-db-prewarm.test.ts src/main/codex/codex-session-migration-scheduler.test.ts --config config/vitest.config.ts`
Expected: PASS. Run `pnpm typecheck` → exit 0 (proves the index.ts closure matches
`MigrationRun`).

- [ ] **Step 5: Commit**

```bash
git add src/main/codex/codex-real-home-hook-install.ts src/main/codex/codex-real-home-hook-install.test.ts src/main/codex/codex-state-db-prewarm.test.ts src/main/index.ts
git commit -m "fix(codex): re-run deferred trust grant when the state-db prewarm completes (#11828)"
```

---

### Task 4: `codexBackfill` IPC channel (main handler + broadcast + preload + web stub)

**Files:**
- Create: `src/shared/codex-backfill-status-types.ts`
- Create: `src/main/ipc/codex-backfill-status.ts`
- Test: `src/main/ipc/codex-backfill-status.test.ts`
- Modify: `src/main/ipc/register-core-handlers.ts` (registration, near
  `registerCodexConfigSyncHandlers(...)` at `~:149`)
- Modify: `src/main/index.ts` (broadcast from the Task-3 prewarm closure)
- Modify: `src/preload/index.ts`, `src/preload/api-types.ts`,
  `src/renderer/src/web/web-preload-api.ts`

**Interfaces:**
- Consumes: `isCodexBackfillIndexPending`, `readCodexStateDbBackfillStatus`
  (Task 1); `getSystemCodexHomePath()`, `getOrcaManagedCodexHomePath()` from
  `src/main/codex/codex-home-paths`; a runtime-home slice
  `{ isHostSystemDefaultRealHome(): boolean }` (the `CodexRuntimeHomeService`
  instance — same object `register-core-handlers.ts` already passes to
  `registerCodexConfigSyncHandlers`).
- Produces (Task 5 relies on these exactly):
  - `export type CodexBackfillGateStatus = { pending: boolean; lastWatermark: string | null }`
  - IPC channels `codexBackfill:status` (invoke → `CodexBackfillGateStatus`) and
    `codexBackfill:statusChanged` (broadcast, payload `CodexBackfillGateStatus`)
  - `window.api.codexBackfill.status(): Promise<CodexBackfillGateStatus>`
  - `window.api.codexBackfill.onStatusChanged(cb): () => void`
  - main exports: `getCodexBackfillGateStatus(runtimeHome)`,
    `registerCodexBackfillStatusHandlers(runtimeHome)`,
    `broadcastCodexBackfillStatusChanged(getWindows, status)`

- [ ] **Step 1: Write the failing test**

`src/main/ipc/codex-backfill-status.test.ts` (node env; mock the codex modules,
test the pure resolution — registration glue mirrors `codex-config-sync.ts` and
stays untested like its peers):

```ts
import { describe, expect, it, vi, beforeEach } from 'vitest'

const { pendingMock, readMock, systemHomeMock, managedHomeMock } = vi.hoisted(() => ({
  pendingMock: vi.fn<() => boolean>(),
  readMock: vi.fn(),
  systemHomeMock: vi.fn(() => '/real/.codex'),
  managedHomeMock: vi.fn<() => string | null>(() => '/managed/home')
}))

vi.mock('../codex/codex-state-db', () => ({
  isCodexBackfillIndexPending: pendingMock,
  readCodexStateDbBackfillStatus: readMock
}))
vi.mock('../codex/codex-home-paths', () => ({
  getSystemCodexHomePath: systemHomeMock,
  getOrcaManagedCodexHomePath: managedHomeMock
}))

import { getCodexBackfillGateStatus } from './codex-backfill-status'

beforeEach(() => {
  vi.clearAllMocks()
  managedHomeMock.mockReturnValue('/managed/home')
})

describe('getCodexBackfillGateStatus', () => {
  it('reports pending with the cursor for the system home on the real-home lane', () => {
    pendingMock.mockReturnValue(true)
    readMock.mockReturnValue({
      kind: 'incomplete',
      stateDbPath: '/real/.codex/state_5.sqlite',
      status: 'running',
      lastWatermark: 'sessions/2026/07/02/rollout-x.jsonl'
    })

    const status = getCodexBackfillGateStatus({ isHostSystemDefaultRealHome: () => true })

    expect(pendingMock).toHaveBeenCalledWith('/real/.codex')
    expect(status).toEqual({ pending: true, lastWatermark: 'sessions/2026/07/02/rollout-x.jsonl' })
  })

  it('targets the managed home off the real-home lane', () => {
    pendingMock.mockReturnValue(false)

    const status = getCodexBackfillGateStatus({ isHostSystemDefaultRealHome: () => false })

    expect(pendingMock).toHaveBeenCalledWith('/managed/home')
    expect(status).toEqual({ pending: false, lastWatermark: null })
  })

  it('fails open when no managed home path resolves', () => {
    managedHomeMock.mockReturnValue(null)

    const status = getCodexBackfillGateStatus({ isHostSystemDefaultRealHome: () => false })

    expect(status).toEqual({ pending: false, lastWatermark: null })
    expect(pendingMock).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run src/main/ipc/codex-backfill-status.test.ts --config config/vitest.config.ts`
Expected: FAIL (module does not exist).

- [ ] **Step 3: Implement**

`src/shared/codex-backfill-status-types.ts`:

```ts
/**
 * Why a narrow shape: the pane only needs go/no-go plus a cheap progress hint;
 * the full CodexStateDbBackfillStatus union stays a main-process concern.
 */
export type CodexBackfillGateStatus = {
  pending: boolean
  /** Backfill cursor (a sessions/... rollout path) while pending; null otherwise. */
  lastWatermark: string | null
}
```

`src/main/ipc/codex-backfill-status.ts`:

```ts
import { ipcMain } from 'electron'
import type { BrowserWindow } from 'electron'
import { getOrcaManagedCodexHomePath, getSystemCodexHomePath } from '../codex/codex-home-paths'
import { isCodexBackfillIndexPending, readCodexStateDbBackfillStatus } from '../codex/codex-state-db'
import type { CodexBackfillGateStatus } from '../../shared/codex-backfill-status-types'

/** The read-only lane slice this channel needs from CodexRuntimeHomeService. */
type CodexHomeLaneResolver = {
  isHostSystemDefaultRealHome: () => boolean
}

/**
 * Status of the codex home a FRESH local pane would read: the real ~/.codex on
 * the real-home lane, else the managed twin. Resume-pinned panes can differ;
 * the output-scanning detector remains their fallback net (#11828).
 */
export function getCodexBackfillGateStatus(
  runtimeHome: CodexHomeLaneResolver
): CodexBackfillGateStatus {
  const home = runtimeHome.isHostSystemDefaultRealHome()
    ? getSystemCodexHomePath()
    : getOrcaManagedCodexHomePath()
  if (!home || !isCodexBackfillIndexPending(home)) {
    return { pending: false, lastWatermark: null }
  }
  const status = readCodexStateDbBackfillStatus(home)
  return {
    pending: true,
    lastWatermark: status.kind === 'incomplete' ? status.lastWatermark : null
  }
}

/** Registers the read-only gate query fresh codex panes check before spawning. */
export function registerCodexBackfillStatusHandlers(runtimeHome: CodexHomeLaneResolver): void {
  ipcMain.removeHandler('codexBackfill:status')
  ipcMain.handle('codexBackfill:status', (): CodexBackfillGateStatus =>
    getCodexBackfillGateStatus(runtimeHome)
  )
}

export function broadcastCodexBackfillStatusChanged(
  getWindows: () => BrowserWindow[],
  status: CodexBackfillGateStatus
): void {
  for (const window of getWindows()) {
    if (window.isDestroyed() || window.webContents.isDestroyed()) {
      continue
    }
    window.webContents.send('codexBackfill:statusChanged', status)
  }
}
```

`src/main/ipc/register-core-handlers.ts` — next to the
`registerCodexConfigSyncHandlers(codexAccounts.runtimeHomeService)` call (`~:149`):

```ts
registerCodexBackfillStatusHandlers(codexAccounts.runtimeHomeService)
```

(plus the import at the top; if the runtime-home service reference is named
differently there, use exactly what `registerCodexConfigSyncHandlers` receives.)

`src/main/index.ts` — extend the Task-3 closure so waiting panes learn about
completion immediately (import `BrowserWindow` is already imported in index.ts;
add imports for the two new functions):

```ts
    startStateDbPrewarm: (options, override) =>
      startCodexStateDbPrewarmInBackground(options, override).then((summaries) => {
        retryRealHomeCodexHookAfterIndex({
          hooksEnabled: isAgentStatusHooksEnabled(store!.getSettings()),
          userDataPath: app.getPath('userData')
        })
        // Why: waiting panes auto-start the moment the index completes instead of
        // waiting out their slow re-poll interval.
        if (codexRuntimeHome) {
          broadcastCodexBackfillStatusChanged(
            () => BrowserWindow.getAllWindows(),
            getCodexBackfillGateStatus(codexRuntimeHome)
          )
        }
        return summaries
      }),
```

`src/preload/index.ts` — add a top-level namespace (import the shared type):

```ts
  codexBackfill: {
    /** Go/no-go for launching codex into a fresh local pane (#11828 index gate). */
    status: (): Promise<CodexBackfillGateStatus> => ipcRenderer.invoke('codexBackfill:status'),
    onStatusChanged: (callback: (status: CodexBackfillGateStatus) => void): (() => void) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        status: CodexBackfillGateStatus
      ): void => callback(status)
      ipcRenderer.on('codexBackfill:statusChanged', listener)
      return () => ipcRenderer.removeListener('codexBackfill:statusChanged', listener)
    }
  } satisfies PreloadApi['codexBackfill'],
```

`src/preload/api-types.ts`:

```ts
  codexBackfill: {
    /** Go/no-go for launching codex into a fresh local pane (#11828 index gate). */
    status: () => Promise<CodexBackfillGateStatus>
    onStatusChanged: (callback: (status: CodexBackfillGateStatus) => void) => () => void
  }
```

`src/renderer/src/web/web-preload-api.ts`:

```ts
    // Why: the web client's panes run on remote hosts whose codex homes this
    // browser cannot inspect; never-pending keeps those spawns ungated.
    codexBackfill: {
      status: () => Promise.resolve({ pending: false, lastWatermark: null }),
      onStatusChanged: () => () => {}
    },
```

- [ ] **Step 4: Run tests + typecheck**

Run: `pnpm exec vitest run src/main/ipc/codex-backfill-status.test.ts --config config/vitest.config.ts`
Expected: PASS.
Run: `pnpm typecheck` → exit 0 (proves preload impl, api-types, and the web stub
all satisfy the same `PreloadApi['codexBackfill']`).

- [ ] **Step 5: Commit**

```bash
git add src/shared/codex-backfill-status-types.ts src/main/ipc/codex-backfill-status.ts src/main/ipc/codex-backfill-status.test.ts src/main/ipc/register-core-handlers.ts src/main/index.ts src/preload/index.ts src/preload/api-types.ts src/renderer/src/web/web-preload-api.ts
git commit -m "feat(codex): expose backfill gate status to the renderer over IPC (#11828)"
```

---

### Task 5: Renderer spawn gate — defer fresh local codex spawns while pending

**Files:**
- Create: `src/renderer/src/components/terminal-pane/codex-backfill-spawn-gate.ts`
- Test: `src/renderer/src/components/terminal-pane/codex-backfill-spawn-gate.test.ts`
- Modify: `src/renderer/src/components/terminal-pane/pty-connection.ts`
- Modify: `src/renderer/src/components/terminal-pane/pty-connection-types.ts`
- Test (extend): `src/renderer/src/components/terminal-pane/pty-connection.test.ts`

**Interfaces:**
- Consumes: `window.api.codexBackfill` (Task 4 shape); inside `connectPanePty`:
  `resolveExpectedLaunchTuiAgent(): TuiAgent | null` (`pty-connection.ts:~1968`),
  `runDeferredConnect` (`:~4410`), `runtimeEnvironmentId` (already in scope near
  the transport selection at `:~3733-3754`), `deps.onPtyErrorRef`-style dep refs.
- Produces (Task 6 relies on these exactly):
  - `export type CodexIndexingPaneState = { lastWatermark: string | null }`
  - `export const CODEX_BACKFILL_GATE_REPOLL_MS = 20_000`
  - `export function waitForCodexBackfillGate(args: { api: CodexBackfillGateApi | undefined; onWaiting: (state: CodexIndexingPaneState) => void; onClear: () => void; repollMs?: number }): () => void`
    (returns a dispose that cancels silently — no `onClear`)
  - `PtyConnectionDeps` gains
    `onCodexIndexingStateRef?: React.RefObject<(paneId: number, state: CodexIndexingPaneState | null) => void>`

- [ ] **Step 1: Write the failing gate-module tests**

`codex-backfill-spawn-gate.test.ts` (node env, fake timers):

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CODEX_BACKFILL_GATE_REPOLL_MS,
  waitForCodexBackfillGate
} from './codex-backfill-spawn-gate'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

function createApi(initial: { pending: boolean; lastWatermark: string | null }): {
  api: Parameters<typeof waitForCodexBackfillGate>[0]['api']
  emit: (status: { pending: boolean; lastWatermark: string | null }) => void
  unsubscribed: () => boolean
} {
  let listener: ((s: { pending: boolean; lastWatermark: string | null }) => void) | null = null
  let unsubscribed = false
  return {
    api: {
      status: vi.fn(() => Promise.resolve(initial)),
      onStatusChanged: (cb) => {
        listener = cb
        return () => {
          unsubscribed = true
        }
      }
    },
    emit: (status) => listener?.(status),
    unsubscribed: () => unsubscribed
  }
}

it('clears immediately when not pending', async () => {
  const { api } = createApi({ pending: false, lastWatermark: null })
  const onClear = vi.fn()
  waitForCodexBackfillGate({ api, onWaiting: vi.fn(), onClear })
  await vi.runOnlyPendingTimersAsync()
  expect(onClear).toHaveBeenCalledTimes(1)
})

it('waits while pending, then clears once on the completion event', async () => {
  const { api, emit, unsubscribed } = createApi({
    pending: true,
    lastWatermark: 'sessions/2026/07/02/rollout-x.jsonl'
  })
  const onWaiting = vi.fn()
  const onClear = vi.fn()
  waitForCodexBackfillGate({ api, onWaiting, onClear })
  await vi.runOnlyPendingTimersAsync()
  expect(onWaiting).toHaveBeenCalledWith({ lastWatermark: 'sessions/2026/07/02/rollout-x.jsonl' })
  expect(onClear).not.toHaveBeenCalled()

  emit({ pending: false, lastWatermark: null })
  emit({ pending: false, lastWatermark: null })
  expect(onClear).toHaveBeenCalledTimes(1)
  expect(unsubscribed()).toBe(true)
})

it('re-polls as a belt over a missed event', async () => {
  const { api } = createApi({ pending: true, lastWatermark: null })
  const onClear = vi.fn()
  waitForCodexBackfillGate({ api, onWaiting: vi.fn(), onClear })
  await vi.runOnlyPendingTimersAsync()
  ;(api!.status as ReturnType<typeof vi.fn>).mockResolvedValue({
    pending: false,
    lastWatermark: null
  })
  await vi.advanceTimersByTimeAsync(CODEX_BACKFILL_GATE_REPOLL_MS)
  expect(onClear).toHaveBeenCalledTimes(1)
})

it('fails open when the api is missing or the query rejects', async () => {
  const onClearMissing = vi.fn()
  waitForCodexBackfillGate({ api: undefined, onWaiting: vi.fn(), onClear: onClearMissing })
  expect(onClearMissing).toHaveBeenCalledTimes(1)

  const onClearError = vi.fn()
  waitForCodexBackfillGate({
    api: {
      status: () => Promise.reject(new Error('ipc down')),
      onStatusChanged: () => () => {}
    },
    onWaiting: vi.fn(),
    onClear: onClearError
  })
  await vi.runOnlyPendingTimersAsync()
  expect(onClearError).toHaveBeenCalledTimes(1)
})

it('dispose cancels silently without onClear', async () => {
  const { api, emit } = createApi({ pending: true, lastWatermark: null })
  const onClear = vi.fn()
  const dispose = waitForCodexBackfillGate({ api, onWaiting: vi.fn(), onClear })
  await vi.runOnlyPendingTimersAsync()
  dispose()
  emit({ pending: false, lastWatermark: null })
  expect(onClear).not.toHaveBeenCalled()
})
```

- [ ] **Step 2: Run gate tests to verify they fail**

Run: `pnpm exec vitest run src/renderer/src/components/terminal-pane/codex-backfill-spawn-gate.test.ts --config config/vitest.config.ts`
Expected: FAIL (module does not exist).

- [ ] **Step 3: Implement the gate module**

`src/renderer/src/components/terminal-pane/codex-backfill-spawn-gate.ts`:

```ts
import type { CodexBackfillGateStatus } from '../../../../shared/codex-backfill-status-types'

export type CodexIndexingPaneState = { lastWatermark: string | null }

export type CodexBackfillGateApi = {
  status: () => Promise<CodexBackfillGateStatus>
  onStatusChanged: (callback: (status: CodexBackfillGateStatus) => void) => () => void
}

// Why: belt over the push event — a pane whose subscription raced the single
// statusChanged broadcast must not stay parked forever.
export const CODEX_BACKFILL_GATE_REPOLL_MS = 20_000

/**
 * Defers a fresh local codex spawn while the target home's session index is
 * incomplete (#11828). Reports progress via onWaiting while deferred, then calls
 * onClear exactly once. Fails open (immediate onClear) when the API is absent
 * (web build) or errors — an IPC failure must never park a pane.
 * Returns a dispose that cancels silently (no onClear) for pane teardown.
 */
export function waitForCodexBackfillGate(args: {
  api: CodexBackfillGateApi | undefined
  onWaiting: (state: CodexIndexingPaneState) => void
  onClear: () => void
  repollMs?: number
}): () => void {
  const api = args.api
  if (!api || typeof api.status !== 'function' || typeof api.onStatusChanged !== 'function') {
    args.onClear()
    return () => {}
  }
  let settled = false
  let repollTimer: ReturnType<typeof setInterval> | null = null
  let unsubscribe: (() => void) | null = null
  const cancel = (): void => {
    settled = true
    unsubscribe?.()
    unsubscribe = null
    if (repollTimer !== null) {
      clearInterval(repollTimer)
      repollTimer = null
    }
  }
  const clear = (): void => {
    if (settled) {
      return
    }
    cancel()
    args.onClear()
  }
  const handleStatus = (status: CodexBackfillGateStatus): void => {
    if (settled) {
      return
    }
    if (status.pending) {
      args.onWaiting({ lastWatermark: status.lastWatermark })
    } else {
      clear()
    }
  }
  unsubscribe = api.onStatusChanged(handleStatus)
  const poll = (): void => {
    api.status().then(handleStatus, clear)
  }
  repollTimer = setInterval(poll, args.repollMs ?? CODEX_BACKFILL_GATE_REPOLL_MS)
  poll()
  return cancel
}
```

Run the Step-2 command again. Expected: PASS.

- [ ] **Step 4: Write the failing `pty-connection` integration tests**

Extend `pty-connection.test.ts`, following its existing seams
(`createMockTransport()`, `transportFactoryQueue.push(transport)`,
`createDeps({ startup: { command: 'codex', launchAgent: 'codex' } })`,
`await flushAsyncTicks()`; `window.api` is stubbed via
`Object.defineProperty(window, 'api', { configurable: true, value: {...} })` —
extend that stub with a controllable `codexBackfill`):

```ts
describe('codex backfill spawn gate (#11828)', () => {
  function stubCodexBackfillApi(initial: { pending: boolean; lastWatermark: string | null }): {
    emit: (status: { pending: boolean; lastWatermark: string | null }) => void
  } {
    let listener: ((s: { pending: boolean; lastWatermark: string | null }) => void) | null = null
    window.api.codexBackfill = {
      status: vi.fn(() => Promise.resolve(initial)),
      onStatusChanged: (cb: (s: { pending: boolean; lastWatermark: string | null }) => void) => {
        listener = cb
        return () => {}
      }
    } as never
    return { emit: (status) => listener?.(status) }
  }

  it('defers a fresh codex spawn while the backfill is pending, then spawns on clear', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport()
    transportFactoryQueue.push(transport)
    const { emit } = stubCodexBackfillApi({ pending: true, lastWatermark: 'sessions/2026/07/02/r.jsonl' })
    const deps = createDeps({ startup: { command: 'codex', launchAgent: 'codex' } })
    deps.onCodexIndexingStateRef = { current: vi.fn() }

    connectPanePty(createPane(1) as never, createManager(1) as never, deps as never)
    await flushAsyncTicks()

    expect(transport.connect).not.toHaveBeenCalled()
    expect(deps.onCodexIndexingStateRef.current).toHaveBeenCalledWith(expect.anything(), {
      lastWatermark: 'sessions/2026/07/02/r.jsonl'
    })

    emit({ pending: false, lastWatermark: null })
    await flushAsyncTicks()

    expect(deps.onCodexIndexingStateRef.current).toHaveBeenCalledWith(expect.anything(), null)
    expect(transport.connect).toHaveBeenCalledTimes(1)
  })

  it('does not gate non-codex panes', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport()
    transportFactoryQueue.push(transport)
    stubCodexBackfillApi({ pending: true, lastWatermark: null })
    const deps = createDeps()

    connectPanePty(createPane(1) as never, createManager(1) as never, deps as never)
    await flushAsyncTicks()

    expect(transport.connect).toHaveBeenCalledTimes(1)
  })

  it('spawns immediately when the backfill is not pending', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport()
    transportFactoryQueue.push(transport)
    stubCodexBackfillApi({ pending: false, lastWatermark: null })
    const deps = createDeps({ startup: { command: 'codex', launchAgent: 'codex' } })

    connectPanePty(createPane(1) as never, createManager(1) as never, deps as never)
    await flushAsyncTicks()

    expect(transport.connect).toHaveBeenCalledTimes(1)
  })

  it('does not gate a reattach to an existing pty', async () => {
    // Why: a reattach joins a live codex process; only fresh spawns can hit the
    // backfill wait. Use the harness's restored-pty seam (restoredPtyIdByLeafId +
    // restoredLeafId, as the branch's session-restore tests do).
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport()
    transportFactoryQueue.push(transport)
    stubCodexBackfillApi({ pending: true, lastWatermark: null })
    const deps = createDeps({ startup: { command: 'codex', launchAgent: 'codex' } })
    // Adapt to the harness's exact reattach fixture — mirror an existing
    // reattach test in this file for the deps shape.
    deps.restoredPtyIdByLeafId = { [deps.restoredLeafId ?? 'leaf-1']: 'pty-existing' }

    connectPanePty(createPane(1) as never, createManager(1) as never, deps as never)
    await flushAsyncTicks()

    expect(transport.connect).toHaveBeenCalledTimes(1)
  })
})
```

(Where this sketch names harness pieces — `createPane`, `createManager`,
`createDeps`, reattach fixtures — mirror the closest existing test in the file;
they all exist today. The behavioral assertions are the contract:
gated = `transport.connect` withheld until clear; ungated = called once,
immediately.)

Run: `pnpm exec vitest run src/renderer/src/components/terminal-pane/pty-connection.test.ts --config config/vitest.config.ts`
Expected: the 4 new tests FAIL (no gate exists); all pre-existing tests PASS —
**if any pre-existing test starts failing because `window.api.codexBackfill` is
undefined in its stub, that is the fail-open path working; do not "fix" it by
requiring the API.**

- [ ] **Step 5: Integrate the gate into `pty-connection.ts`**

1. `pty-connection-types.ts` — next to `onPtyRecoveryStateRef` (`:66-68`):

```ts
  /** Pane-level codex indexing wait state (#11828 spawn gate); null clears it. */
  onCodexIndexingStateRef?: React.RefObject<
    (paneId: number, state: CodexIndexingPaneState | null) => void
  >
```

with `import type { CodexIndexingPaneState } from './codex-backfill-spawn-gate'`.

2. `pty-connection.ts` — import
`{ waitForCodexBackfillGate } from './codex-backfill-spawn-gate'`. Near the other
connect-state locals (by `connectStarted` / `startupGridSettledForConnect`):

```ts
  let codexBackfillGateCleared = false
  let codexBackfillGateDispose: (() => void) | null = null
  // Why: only a fresh LOCAL spawn launches a new codex against a home main can
  // inspect; reattaches join a live process and remote homes are unreachable.
  const shouldGateCodexSpawnOnBackfill = (): boolean =>
    !runtimeEnvironmentId &&
    !hasRestoredPtyForThisLeaf &&
    resolveExpectedLaunchTuiAgent() === 'codex'
```

For `hasRestoredPtyForThisLeaf`, use the exact fresh-vs-reattach discriminator the
surrounding code already uses for the `:5056` connect (the restored pty id for
this pane's leaf, e.g. `deps.restoredPtyIdByLeafId?.[deps.restoredLeafId ?? '']`
or the local variable `connectPanePty` derives from it — locate it where
`transport.connect` chooses reattach; do NOT invent a new signal). The Step-4
reattach test pins the required behavior.

3. In `runDeferredConnect` (`:~4410`), add a second deferral clause after the
startup-grid clause and before `connectStarted = true`, mirroring the existing
idiom exactly:

```ts
    if (!codexBackfillGateCleared && shouldGateCodexSpawnOnBackfill()) {
      cancelScheduledConnectFrame()
      if (connectFallbackTimer !== null) {
        clearTimeout(connectFallbackTimer)
        connectFallbackTimer = null
      }
      codexBackfillGateDispose = waitForCodexBackfillGate({
        api: window.api.codexBackfill,
        onWaiting: (state) => deps.onCodexIndexingStateRef?.current?.(pane.id, state),
        onClear: () => {
          codexBackfillGateDispose = null
          codexBackfillGateCleared = true
          deps.onCodexIndexingStateRef?.current?.(pane.id, null)
          runDeferredConnect()
        }
      })
      return
    }
```

4. In the binding's dispose/cleanup path (where `disposed = true` is set and
frames/timers are cancelled), add:

```ts
    codexBackfillGateDispose?.()
    codexBackfillGateDispose = null
    deps.onCodexIndexingStateRef?.current?.(pane.id, null)
```

Keep the addition to `pty-connection.ts` to roughly these ~30 lines; all other
logic stays in the sibling module (no `max-lines` growth beyond this).

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm exec vitest run src/renderer/src/components/terminal-pane/pty-connection.test.ts src/renderer/src/components/terminal-pane/codex-backfill-spawn-gate.test.ts --config config/vitest.config.ts`
Expected: PASS (all, including every pre-existing pty-connection test).
Run `pnpm typecheck` → exit 0.

- [ ] **Step 7: Commit**

```bash
git add src/renderer/src/components/terminal-pane/codex-backfill-spawn-gate.ts src/renderer/src/components/terminal-pane/codex-backfill-spawn-gate.test.ts src/renderer/src/components/terminal-pane/pty-connection.ts src/renderer/src/components/terminal-pane/pty-connection-types.ts src/renderer/src/components/terminal-pane/pty-connection.test.ts
git commit -m "feat(terminal): gate fresh codex spawns behind the session-index backfill (#11828)"
```

---

### Task 6: Pane indexing overlay UI + i18n

**Files:**
- Create: `src/renderer/src/components/terminal-pane/CodexIndexingOverlay.tsx`
- Test: `src/renderer/src/components/terminal-pane/CodexIndexingOverlay.test.tsx`
- Modify: `src/renderer/src/components/terminal-pane/TerminalPane.tsx`
- Modify (generated): `src/renderer/src/i18n/locales/en.json` + `es/ja/ko/zh`
  via `pnpm run sync:localization-catalog`

**Interfaces:**
- Consumes: `CodexIndexingPaneState` (Task 5); `translate` from `@/i18n/i18n`;
  `Loader2` from `lucide-react`; `createPortal` + `managedPanes` +
  `pane.container` (the exact pattern `TerminalPane.tsx:2975-2991` uses for
  `TerminalSshReconnectOverlay`); dep-wiring sites where `onPtyRecoveryStateRef`
  is passed into `connectPanePty` deps (`TerminalPane.tsx:~1453` and `~1657`).
- Produces:
  - `export function CodexIndexingOverlay({ state }: { state: CodexIndexingPaneState }): React.JSX.Element`
  - `export function formatCodexIndexingProgress(lastWatermark: string | null): string | null`

- [ ] **Step 1: Write the failing tests**

`CodexIndexingOverlay.test.tsx` (component tests need the pragma on line 1):

```tsx
// @vitest-environment happy-dom
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { CodexIndexingOverlay, formatCodexIndexingProgress } from './CodexIndexingOverlay'

describe('formatCodexIndexingProgress', () => {
  it('extracts the date from a rollout cursor path', () => {
    expect(
      formatCodexIndexingProgress('sessions/2026/07/02/rollout-2026-07-02T07-08-32.jsonl')
    ).toBe('2026-07-02')
  })

  it('handles Windows separators', () => {
    expect(formatCodexIndexingProgress('sessions\\2026\\07\\02\\rollout-x.jsonl')).toBe(
      '2026-07-02'
    )
  })

  it('returns null for null or unrecognized cursors', () => {
    expect(formatCodexIndexingProgress(null)).toBeNull()
    expect(formatCodexIndexingProgress('something-else')).toBeNull()
  })
})

describe('CodexIndexingOverlay', () => {
  it('shows the indexing headline and auto-start hint', () => {
    render(<CodexIndexingOverlay state={{ lastWatermark: null }} />)
    expect(screen.getByText('Indexing Codex session history…')).toBeTruthy()
    expect(
      screen.getByText('Codex will start automatically when indexing finishes.')
    ).toBeTruthy()
  })

  it('shows a progress date when the cursor is parseable', () => {
    render(
      <CodexIndexingOverlay
        state={{ lastWatermark: 'sessions/2026/07/02/rollout-x.jsonl' }}
      />
    )
    expect(
      screen.getByText(
        'Indexed through 2026-07-02. Codex will start automatically when indexing finishes.'
      )
    ).toBeTruthy()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm exec vitest run src/renderer/src/components/terminal-pane/CodexIndexingOverlay.test.tsx --config config/vitest.config.ts`
Expected: FAIL (module does not exist).

- [ ] **Step 3: Implement the component**

`src/renderer/src/components/terminal-pane/CodexIndexingOverlay.tsx`:

```tsx
import { Loader2 } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import type { CodexIndexingPaneState } from './codex-backfill-spawn-gate'

/** Extracts a YYYY-MM-DD hint from the backfill cursor (sessions/YYYY/MM/DD/rollout-*.jsonl). */
export function formatCodexIndexingProgress(lastWatermark: string | null): string | null {
  const match = /sessions[/\\](\d{4})[/\\](\d{2})[/\\](\d{2})[/\\]/.exec(lastWatermark ?? '')
  return match ? `${match[1]}-${match[2]}-${match[3]}` : null
}

/** In-pane wait state while the codex session index finishes (#11828 spawn gate). */
export function CodexIndexingOverlay({
  state
}: {
  state: CodexIndexingPaneState
}): React.JSX.Element {
  const progressDate = formatCodexIndexingProgress(state.lastWatermark)
  return (
    <div className="absolute inset-x-3 bottom-3 z-50 flex items-center gap-2 rounded-md border border-border bg-muted px-3 py-2 text-xs text-muted-foreground">
      <Loader2 className="size-4 shrink-0 animate-spin" />
      <div className="min-w-0">
        <div>
          {translate(
            'auto.components.terminal.pane.CodexIndexingOverlay.indexing',
            'Indexing Codex session history…'
          )}
        </div>
        <div>
          {progressDate
            ? translate(
                'auto.components.terminal.pane.CodexIndexingOverlay.progressThrough',
                'Indexed through {{value0}}. Codex will start automatically when indexing finishes.',
                { value0: progressDate }
              )
            : translate(
                'auto.components.terminal.pane.CodexIndexingOverlay.autoStart',
                'Codex will start automatically when indexing finishes.'
              )}
        </div>
      </div>
    </div>
  )
}
```

Run the Step-2 command again. Expected: PASS.

- [ ] **Step 4: Wire `TerminalPane.tsx`**

Next to the existing `onPtyRecoveryStateRef` state/handler (`:~582-588`):

```tsx
  const [codexIndexingStatesByPaneId, setCodexIndexingStatesByPaneId] = useState<
    Record<number, CodexIndexingPaneState>
  >({})
  const onCodexIndexingStateRef = useRef(
    (paneId: number, state: CodexIndexingPaneState | null) => {
      setCodexIndexingStatesByPaneId((previous) => {
        if (state === null) {
          if (!(paneId in previous)) {
            return previous
          }
          const next = { ...previous }
          delete next[paneId]
          return next
        }
        return { ...previous, [paneId]: state }
      })
    }
  )
```

Pass `onCodexIndexingStateRef` into BOTH `connectPanePty` dep sites (the same two
places `onPtyRecoveryStateRef` is wired, `:~1453` and `:~1657`).

Render next to the SSH-overlay portal block (`:~2975`) — same portal pattern
(anything not portaled into `pane.container` paints UNDER the xterm WebGL canvas):

```tsx
      {/* Why: portal into the pane so the indexing notice stacks above the xterm canvas. */}
      {managedPanes.map((pane) =>
        codexIndexingStatesByPaneId[pane.id]
          ? createPortal(
              <CodexIndexingOverlay state={codexIndexingStatesByPaneId[pane.id]} />,
              pane.container,
              `codex-indexing-${pane.id}`
            )
          : null
      )}
```

- [ ] **Step 5: Sync the i18n catalogs**

```bash
pnpm run sync:localization-catalog
```

Expected: the three `CodexIndexingOverlay` keys land in all five locale JSONs
(non-English seeded with English until translated — the repo's standard flow).

- [ ] **Step 6: Run tests + lint + typecheck**

Run: `pnpm exec vitest run src/renderer/src/components/terminal-pane/CodexIndexingOverlay.test.tsx src/renderer/src/components/terminal-pane/pty-connection.test.ts --config config/vitest.config.ts`
Expected: PASS.
Run: `pnpm lint && pnpm typecheck` → both exit 0 (lint includes
`verify:localization-catalog`, proving Step 5).

- [ ] **Step 7: Commit**

```bash
git add src/renderer/src/components/terminal-pane/CodexIndexingOverlay.tsx src/renderer/src/components/terminal-pane/CodexIndexingOverlay.test.tsx src/renderer/src/components/terminal-pane/TerminalPane.tsx src/renderer/src/i18n/locales
git commit -m "feat(terminal): show an indexing overlay while a codex pane waits for the backfill (#11828)"
```

---

### Task 7: Full gates

**Files:** none new — verification only. Fix regressions this branch caused; do
NOT touch the known pre-existing failures.

- [ ] **Step 1: Run all four gates, individually (to attribute failures)**

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Expected: `lint`, `typecheck`, `build` exit 0. `pnpm test` is expected to show
ONLY the 7 known pre-existing failures (Global Constraints) plus possibly the 2
known load-flakes; anything else is a branch regression — fix it.

- [ ] **Step 2: Prove branch-owned tests pass 100%**

```bash
pnpm exec vitest run --config config/vitest.config.ts \
  src/main/codex/codex-state-db.test.ts \
  src/main/codex/codex-state-db-prewarm.test.ts \
  src/main/codex/codex-session-migration-scheduler.test.ts \
  src/main/codex/codex-real-home-hook-install.test.ts \
  src/main/ipc/codex-backfill-status.test.ts \
  src/renderer/src/components/terminal-pane/codex-backfill-error-detector.test.ts \
  src/renderer/src/components/terminal-pane/codex-backfill-spawn-gate.test.ts \
  src/renderer/src/components/terminal-pane/CodexIndexingOverlay.test.tsx \
  src/renderer/src/components/terminal-pane/TerminalErrorToast.test.ts \
  src/renderer/src/components/terminal-pane/pty-connection.test.ts
```

Expected: 0 failures.

- [ ] **Step 3: Commit any fixes**

Only if Steps 1–2 forced changes; scoped messages, e.g.
`git commit -m "fix(codex): address gate findings for backfill ordering"`.
No empty commits.

---

### Task 8: Sandboxed reporter-shape E2E (the actual #11828 scenario, end to end)

**Files:** none — disposable sandboxed HOME + read-only inspection of real homes.
This re-runs the previous run's E2E with the fix for its HALT; it takes tens of
minutes of wall clock while the 15 GB index runs. **LET IT RUN — poll, do not
time out at a few minutes** (prewarm deadline is 60 min; 15 GB measured 10–13 min
on this machine).

**Safety protocol (identical to the proven previous run — violations are HALT):**
real homes (`~/.codex`, `~/.local/share/orca/codex-runtime-home`) get read-only
`mode=ro` sqlite / `ls` / `stat` access ONLY; the sandbox gets real copies
(`cp -a`, never `cp -al` — verify inodes differ); full cleanup afterward.

- [ ] **Step 1: Set up the sandbox**

```bash
REAL_HOME="$HOME"
E2E_ROOT=$(mktemp -d /tmp/orca-e2e-11828.XXXXXX)   # private 0700 dir
E2E_DATA="$E2E_ROOT/userdata"
E2E_HOME="$E2E_DATA/home"
mkdir -p "$E2E_HOME/.codex"
# Real copies, NOT hardlinks (codex can rewrite rollout files); takes minutes for 15 GB.
cp -a "$REAL_HOME/.codex/sessions" "$E2E_HOME/.codex/sessions"
# Verify no hardlinks into ~/.codex: pick any copied file; link count must be 1
# and its inode must differ from the original's.
find "$E2E_HOME/.codex/sessions" -name '*.jsonl' | head -1 | xargs stat -c '%h %i'
# Seed credentials/config so codex can start inside the sandbox.
cp "$REAL_HOME/.codex/auth.json" "$E2E_HOME/.codex/auth.json"
cp "$REAL_HOME/.codex/config.toml" "$E2E_HOME/.codex/config.toml" 2>/dev/null || true
# Do NOT copy state_*.sqlite — the sandbox must look like the reporter's home:
# a large session history with no completed index.
ls "$E2E_HOME/.codex"   # expect: sessions/ auth.json config.toml — nothing else
```

- [ ] **Step 2: Launch from the dev shell (inherited PATH resolves codex/node)**

```bash
env -u CODEX_HOME -u ORCA_CODEX_HOME -u ZDOTDIR -u BASH_ENV \
  HOME="$E2E_HOME" USERPROFILE="$E2E_HOME" \
  ORCA_E2E_USER_DATA_DIR="$E2E_DATA" ORCA_E2E_HOME_DIR="$E2E_HOME" \
  ORCA_CODEX_SYSTEM_DEFAULT_REAL_HOME=1 \
  pnpm dev
```

(Capture output to a log file. If a codex pane later reports
`codex: command not found`, re-launch with the real `codex`/`node` bin dirs
prepended to `PATH` and record the adjustment.)

- [ ] **Step 3: Observe and record each of (this run's SUCCESS CRITERIA)**

1. **Trust grant deferred, lane NOT latched.** Within ~60s the log contains
   `[codex-real-home-hooks] deferring trust grant until codex session index completes`
   and contains NO `CodexAppServerTimeoutError` and NO
   `[codex-real-home-hooks] trust grant unavailable` line.
2. **Scheduler + prewarm run.** After the ~15s scheduler timer:
   `[codex-state-db-prewarm] pre-warming codex session index at $E2E_HOME/.codex (this can take minutes on large histories)`
   appears, and a codex child exists with `CODEX_HOME=$E2E_HOME/.codex`
   (find candidates with `pgrep -af 'app-server'`, confirm via
   `tr '\0' '\n' </proc/<pid>/environ | grep '^CODEX_HOME='` — the env value is
   the discriminator; other Orca instances spawn identical command lines).
3. **Pane shows the indexing state instead of dying.** While the index runs, open
   a Codex pane in the app: the pane shows the
   "Indexing Codex session history…" overlay and codex is NOT launched into the
   failure (no "damaged database" output). A plain shell pane spawns normally
   with no overlay. (The amber toast from the previous half of the fix should NOT
   appear on this path — it remains only as the race fallback.)
4. **Index completes; grant retried; pane auto-starts.** Poll every ~60s
   (up to 75 min):
   `sqlite3 "file:$E2E_HOME/.codex/state_5.sqlite?mode=ro" "select status from backfill_state;"`
   flips to `complete`; the log shows
   `[codex-state-db-prewarm] codex session index complete`, then a successful
   trust grant (`[codex-trust-grant] granted ... via codex app-server`, and no
   `trust grant unavailable` latch); the waiting pane's overlay clears and codex
   starts in it (TUI renders).
5. **Steady state.** A new Codex pane starts normally (no overlay, no toast).
   Quit and relaunch with the same env block: no deferral line, no new prewarm
   spawn (`backfill_state` now reads `complete`).

Notes: if the run inherits a stale `'running'` lease (e.g. from an interrupted
attempt), the prewarm spawning anyway and codex adopting the index within ≤15 min
is the DOCUMENTED behavior Task 3's unit test pins — record it, keep waiting, do
not treat it as failure. If any observation genuinely cannot be produced, capture
the relevant log lines + scheduler eligibility state and HALT with the evidence —
do not fake observations.

- [ ] **Step 4: Clean up (mandatory, verify)**

```bash
# Kill the E2E app processes by PID (verify with pgrep that nothing references the sandbox),
# then:
rm -rf "$E2E_ROOT"
ls -d /tmp/orca-e2e-11828.* 2>/dev/null   # expect: none
# Real homes untouched (read-only checks):
sqlite3 "file:$HOME/.local/share/orca/codex-runtime-home/home/state_5.sqlite?mode=ro" "select status from backfill_state;"   # complete
sqlite3 "file:$HOME/.codex/state_5.sqlite?mode=ro" "select status from backfill_state;"                                      # complete
du -sh "$HOME/.codex/sessions"   # still ~15G
```

- [ ] **Step 5: Commit any fixes from the verification**

If Steps 1–4 forced code changes, re-run the affected unit tests and the four
gates, then commit scoped, e.g.
`git commit -m "fix(codex): address startup-ordering e2e findings (#11828)"`.
If nothing changed, skip the commit.

---

## Self-review record

- **Spec coverage:** design decision (1) state-first ordering + non-latching
  `'pending-index'` → Tasks 1–2 (defer happens inside
  `ensureRealHomeCodexHookState`, so ALL its call sites — startup `index.ts:2503`,
  per-pane launch prep `:847`/`:973` — stop spawning doomed codexes);
  (2) scheduler/prewarm run while pending + stale-lease handling verified →
  Task 2 (lane stays usable ⇒ `isEligible()` stays true) + Task 3's explicit
  stale-`running`-lease unit test; (3) grant re-run on prewarm completion with
  genuine failures keeping `'unavailable'` → Task 3 (the `installRetryAfterMs`
  throttle trap is avoided by construction: it only applies when the lane is
  already `'unavailable'`, and `retryRealHomeCodexHookAfterIndex` only acts from
  `'pending-index'`); (4) pane UX: no doomed launch + indexing spinner/status with
  cheap progress + auto-start + detector/toast kept as fallback → Tasks 4–6
  (detector and toast untouched); unit tests for ordering/pending-lane and pane
  gating → Tasks 1–6; full gates with the pre-existing-failure carve-out → Task 7;
  sandboxed reporter-shape E2E with the new success criteria, LET-IT-RUN polling,
  and real-home safety → Task 8.
- **No silent deferrals:** both user-facing outcomes are proven against production
  behavior in Task 8 (real 15 GB history as safe copies, real codex binary, real
  panes); mocks/stubs exist only in unit tests, and each mocked seam
  (`isCodexBackfillIndexPending`, `codexBackfill` IPC, transports) has its real
  counterpart exercised by Task 8's observations 1–5. No requirement was moved to
  known-limitations/future-work; there are no unresolved coverage gaps. Two scope
  notes that are behavior-preserving refinements, not reductions: small-history
  homes don't defer (the grant codex isn't doomed there — documented in
  Background); resume-pinned panes reading the managed home are gated against the
  fresh-pane home, with the existing detector+toast as their net (documented in
  `getCodexBackfillGateStatus`'s doc comment).
- **Placeholder scan:** every code step carries concrete code; the only
  "adapt to existing helpers" notes point at named, existing harness pieces
  (`createDeps`, `createMockTransport`, `grantSucceeds`, timer-advance helpers)
  with the behavioral contract pinned by explicit assertions — no TBDs, no
  "similar to Task N" references.
- **Type consistency:** `isCodexBackfillIndexPending(codexHomePath: string): boolean`
  (T1 → T2, T4); `incomplete` variant `{ kind; stateDbPath; status; lastWatermark }`
  (T1 → T4); `RealHomeCodexHookLane` with `'pending-index'` (T2 → T3);
  `retryRealHomeCodexHookAfterIndex(args): RealHomeCodexHookLane` (T3 → index.ts);
  `CodexBackfillGateStatus = { pending; lastWatermark }` (T4 → T5 preload/gate/web
  stub); `waitForCodexBackfillGate` / `CodexIndexingPaneState` /
  `CODEX_BACKFILL_GATE_REPOLL_MS` (T5 → T5 integration, T6);
  `onCodexIndexingStateRef` dep (T5 types → T6 wiring); overlay exports
  `CodexIndexingOverlay` / `formatCodexIndexingProgress` (T6). Scheduler
  `MigrationRun` shape `(options, override?) => Promise<unknown>` is preserved by
  the T3/T4 closure. All checked; names match across tasks.
