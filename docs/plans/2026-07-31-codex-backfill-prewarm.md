# Codex State-DB Backfill Pre-warm Implementation Plan

> **For agentic workers:** This plan is executed task-by-task by the
> workflow's execute stage: a fresh implementer per task, with a spec +
> quality review after each task. Steps use checkbox (`- [ ]`) syntax
> for tracking.

**Goal:** Fix GitHub issue #11828 — Codex panes deterministically fail with a misleading
"local database appears to be damaged" error when Orca's managed `CODEX_HOME` contains a
large session history, because Codex 0.146's one-time state-DB index takes longer than the
~30s Codex waits at startup, and a pane's Codex never lives long enough to finish it.

**Architecture:** Two independent halves. (A) **Pre-warm (main process):** after the
existing Codex session migration chain (backfill → index-heal), supervise a hidden headless
`codex app-server` process against **each local Codex home panes actually use** — first the
system home (`systemCodexHomePath`, what fresh panes run on while the real-home lane is
selected), then the managed home (used by resume-pinned panes) — until the `backfill_state`
row in `state_<N>.sqlite` reads `complete`, so the one-time index finishes in the background
instead of dying in 30s pane slices. (B) **Surfacing (renderer):** detect Codex's
backfill-timeout failure signature in codex-pane output and overlay an accurate explanation
via the existing `TerminalErrorToast`, replacing the misleading "damaged database" story.

**Tech Stack:** Electron main process (TypeScript, Node 24), `node:sqlite` via the existing
`SyncDatabase` adapter, `node:child_process`, React renderer, Vitest 4.

## Global Constraints

- PR targets `main` (explicit user requirement); working branch stays a `danshapiro/...`-style feature branch.
- Cross-platform (macOS / Linux / Windows): paths via `path.join`; Windows spawns via `getSpawnArgsForWindows` from `src/main/win32-utils.ts` + `windowsHide: true` (AGENTS.md).
- SSH use case: the pre-warm targets only **local** Codex homes — the system home and the managed home, the two homes local panes actually use (same scope as the existing local-only session backfill/heal); WSL, SSH, and per-account lanes are out of scope for half A (ledger AD-3) and get only the renderer-side detector, which works for any pane because it scans pane output. State this in code comments where relevant.
- Comments: concise 1-line `// Why:` for non-obvious decisions only (AGENTS.md).
- NEVER add a `max-lines` lint disable; budgets are 300 lines per `.ts`, 400 per `.tsx`, 800 per test file — split files instead (AGENTS.md).
- No vague filenames (`utils`, `helpers`, `common`) — name after the domain concept.
- Tests: Vitest 4, co-located `foo.test.ts` next to `foo.ts`; run one file with `pnpm test <path>`.
- Never open the Codex state DB for writing — read-only `SyncDatabase` opens only. Never delete, rewrite, or reset any `state_*.sqlite` (companion issue #11830 covers interrupted-index corruption; do not make it worse).
- Tests and smoke checks must never touch the user's real `~/.codex` or the real managed home `~/.local/share/orca/codex-runtime-home/home` — temp dirs (`mkdtempSync`) only. Read-only inspection of the real homes is allowed for verification.
- Gates before PR: `pnpm lint && pnpm typecheck && pnpm test && pnpm build`.
- The state-DB filename is schema-versioned (`state_5.sqlite` today); all code must discover the newest `state_<N>.sqlite` rather than hard-coding `5`.

---

## Background for implementers (zero-context summary)

- Orca gives Codex panes a managed `CODEX_HOME` (Linux: `~/.local/share/orca/codex-runtime-home/home`, built by `getOrcaManagedCodexHomePath()` in `src/main/codex/codex-home-paths.ts` = `join(getOrcaUserDataPath(), 'codex-runtime-home', 'home')`). That home ends up containing the user's full session history under `sessions/YYYY/MM/DD/rollout-*.jsonl` (hardlinked; reporter: 4,836 files / 15 GB).
- Codex ≥ 0.146 keeps a SQLite state DB at `<CODEX_HOME>/state_<N>.sqlite` with a table:
  ```sql
  CREATE TABLE backfill_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      status TEXT NOT NULL,
      last_watermark TEXT,
      last_success_at INTEGER,
      updated_at INTEGER NOT NULL
  );
  ```
  On first launch Codex indexes the entire session history ("state db backfill").
- **Verified Codex 0.146 internals** (openai/codex tag `rust-v0.146.0` + live runs; see the
  Stage-2 assumption ledger `load-bearing-ledger.md` in the workflow logs dir):
  - `status` is a closed enum: `pending` / `running` / `complete`; Codex's startup gate is
    exactly `status == 'complete'` on row `id = 1` of the newest `state_<N>.sqlite`
    (0.146 pins `state_5.sqlite`).
  - Exactly one process at a time **claims** the backfill via an atomic in-DB lease
    (`UPDATE ... WHERE status != 'complete' AND (status != 'running' OR updated_at <= now - 900s)`);
    the lease is renewed at every 200-file checkpoint, which also persists a resume watermark.
  - The **claimer blocks inside init and runs the whole index with no internal time limit**
    (a pane whose codex wins the claim looks hung until the index finishes).
    **Non-claimants** wait ~30s, print
    `timed out waiting for state db backfill ... after 30s (status: running)` and
    `Codex couldn't start because its local database appears to be damaged.` to **stderr**
    (wording stable since 0.129, `rollout/src/state_db.rs:171`), then exit.
  - Killing a claimer mid-index does **not** corrupt the DB (`integrity_check` verified), but
    leaves a stale `running` lease: **every** codex start against that home fails at ~30s for
    up to 900s, after which a new claimer steals the lease and resumes from the watermark.
  - Headless `codex -s read-only -a untrusted app-server` with a scoped `CODEX_HOME`, stdin
    held open, and no handshake creates the state DB and drives the backfill to completion
    (verified live); it exits on stdin EOF, and exits ~30s after start if it fails to claim.
  - An external read-only SQLite connection can poll `backfill_state` while codex actively
    writes (verified: hundreds of polls, zero busy errors; only a <1s transient
    "unable to open database file" at DB-creation instant — the poller must tolerate it).
  - Measured throughput ~21-27 MB/s ⇒ the reporter-scale 15 GB history indexes in ~10-13 min.
- **Which home do panes use?** When `isHostSystemDefaultRealHome() === true` (the migration
  scheduler's eligibility gate, `src/main/index.ts:2082-2089`), **fresh panes run on the real
  `~/.codex`** — `prepareForCodexLaunch` returns null (`src/main/codex-accounts/runtime-home-service.ts:175-181`);
  only **resume-pinned** panes (`src/main/codex/codex-pane-launch-account.ts:19-23`) use the
  managed home. The existing index-heal stage already pins `CODEX_HOME: systemCodexHomePath`
  for the same reason (`src/main/codex/codex-session-index-heal.ts:261-275`). The prewarm
  therefore targets **both** homes: system home first, then the managed home. Gate-false
  lanes (shared managed mirror, per-account, WSL) never run the scheduler and get only the
  renderer toast (accepted; ledger AD-3).
- **Binary note:** panes resolve `codex` via the user's login shell (or
  `settings.agentCmdOverrides`), while the prewarm uses `resolveCodexCommand()`; divergence
  is accepted (ledger AD-2) — in the common case both resolve the same binary, and a mismatch
  degrades to a no-op prewarm, never corruption.
- The existing maintenance hook is `createCodexSessionMigrationScheduler` (`src/main/codex/codex-session-migration-scheduler.ts`, 87 lines), wired in `src/main/index.ts:2082-2103`, which chains `startBackfill` → `startIndexHeal` 15s after startup and on host-system-default selection. We chain the pre-warm as a third stage.
- The exemplar for spawning the Codex CLI from main is `src/main/rate-limits/codex-fetcher.ts:568-591` (uses `resolveCodexCommand()` from `src/main/codex-cli/command.ts:202`, `getSpawnArgsForWindows`, `windowsHide: true`, scoped `CODEX_HOME` env — never mutates `process.env`).
- SQLite reads use `SyncDatabase` (`src/main/sqlite/sync-database.ts`):
  ```ts
  class SyncDatabase {
    constructor(path: SqlitePath, options: { readonly?: boolean; fileMustExist?: boolean; timeout?: number } = {})
    exec(sql: string): void
    prepare(sql: string): StatementSync
    pragma(sql: string, options?: { simple?: boolean }): unknown
    close(): void
  }
  export default SyncDatabase
  ```
- Renderer: incoming pane bytes flow through `dataCallback` in
  `src/renderer/src/components/terminal-pane/pty-connection.ts:7217`, which already hosts a
  band of string scanners at `:7275-7308`. Errors surface via `reportError(message)`
  (`pty-connection.ts:4448`) → `TerminalPane.tsx` `setTerminalError` → `TerminalErrorToast`
  overlay (`TerminalErrorToast.tsx`, renders `error` with `whiteSpace: 'pre-wrap'`).
  The pane's launch agent is known via `resolveExpectedLaunchTuiAgent()`
  (`pty-connection.ts:1967`, returns `TuiAgent | null`).

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `src/main/codex/codex-state-db.ts` | Create | Locate newest `state_<N>.sqlite` in a Codex home; read `backfill_state.status` read-only; bounded session-file count |
| `src/main/codex/codex-state-db.test.ts` | Create | Unit tests with real temp SQLite fixtures |
| `src/main/codex/codex-state-db-prewarm.ts` | Create | Supervise a headless codex until the index completes; decision gate, respawn budget, deadline; background single-flight wrapper |
| `src/main/codex/codex-state-db-prewarm.test.ts` | Create | Loop tests with injected deps + fake timers |
| `src/main/codex/codex-session-migration-scheduler.ts` | Modify | Chain `startStateDbPrewarm` after index-heal |
| `src/main/codex/codex-session-migration-scheduler.test.ts` | Modify | Chaining/stop-propagation tests |
| `src/main/index.ts` (~:2082-2103) | Modify | Pass `startCodexStateDbPrewarmInBackground` to the scheduler |
| `src/renderer/src/components/terminal-pane/codex-backfill-error-detector.ts` | Create | Rolling-buffer detector for the backfill-timeout signature; user-facing notice text |
| `src/renderer/src/components/terminal-pane/codex-backfill-error-detector.test.ts` | Create | Chunk-split / ANSI / one-shot tests |
| `src/renderer/src/components/terminal-pane/TerminalErrorToast.tsx` | Modify | `isCodexBackfillIndexingNotice` classifier; informational (amber) styling; no daemon-restart/file-an-issue framing for this notice |
| `src/renderer/src/components/terminal-pane/TerminalErrorToast.test.ts` | Modify | Classifier tests |
| `src/renderer/src/components/terminal-pane/pty-connection.ts` | Modify | Instantiate detector; observe codex-pane data; raise `reportError` |
| `src/renderer/src/components/terminal-pane/pty-connection.test.ts` | Modify | Integration tests: codex pane surfaces notice; non-codex pane does not |

---

### Task 1: Codex state-DB status reader (`codex-state-db.ts`)

**Files:**
- Create: `src/main/codex/codex-state-db.ts`
- Test: `src/main/codex/codex-state-db.test.ts`

**Interfaces:**
- Consumes: `SyncDatabase` from `src/main/sqlite/sync-database.ts` (see Background).
- Produces (used by Task 2):
  ```ts
  export type CodexStateDbBackfillStatus =
    | { kind: 'complete'; stateDbPath: string }
    | { kind: 'incomplete'; stateDbPath: string; status: string }
    | { kind: 'missing' }
    | { kind: 'not-tracked'; stateDbPath: string }
    | { kind: 'unreadable'; stateDbPath: string; error: string }
  export function findNewestCodexStateDbPath(codexHomePath: string): string | null
  export function readCodexStateDbBackfillStatus(codexHomePath: string): CodexStateDbBackfillStatus
  export function countCodexSessionFilesUpTo(sessionsRoot: string, limit: number): number
  ```

- [ ] **Step 1: Write the failing tests**

Create `src/main/codex/codex-state-db.test.ts`:

```ts
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  countCodexSessionFilesUpTo,
  findNewestCodexStateDbPath,
  readCodexStateDbBackfillStatus
} from './codex-state-db'

let home: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'orca-codex-state-db-'))
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

function createStateDb(name: string, status?: string): string {
  const dbPath = join(home, name)
  const db = new DatabaseSync(dbPath)
  if (status !== undefined) {
    db.exec(
      `CREATE TABLE backfill_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        status TEXT NOT NULL,
        last_watermark TEXT,
        last_success_at INTEGER,
        updated_at INTEGER NOT NULL
      )`
    )
    db.prepare('INSERT INTO backfill_state (id, status, updated_at) VALUES (1, ?, ?)').run(
      status,
      Date.now()
    )
  }
  db.close()
  return dbPath
}

describe('findNewestCodexStateDbPath', () => {
  it('returns null when the home has no state db', () => {
    expect(findNewestCodexStateDbPath(home)).toBeNull()
  })

  it('returns null when the home directory does not exist', () => {
    expect(findNewestCodexStateDbPath(join(home, 'nope'))).toBeNull()
  })

  it('picks the highest schema version', () => {
    createStateDb('state_5.sqlite', 'complete')
    const newest = createStateDb('state_12.sqlite', 'running')
    createStateDb('state_9.sqlite', 'complete')
    expect(findNewestCodexStateDbPath(home)).toBe(newest)
  })

  it('ignores non-matching filenames like state_5.sqlite-wal', () => {
    createStateDb('state_5.sqlite', 'complete')
    writeFileSync(join(home, 'state_6.sqlite-wal'), '')
    writeFileSync(join(home, 'logs_2.sqlite'), '')
    expect(findNewestCodexStateDbPath(home)).toBe(join(home, 'state_5.sqlite'))
  })
})

describe('readCodexStateDbBackfillStatus', () => {
  it('reports missing when no state db exists', () => {
    expect(readCodexStateDbBackfillStatus(home)).toEqual({ kind: 'missing' })
  })

  it('reports complete', () => {
    const dbPath = createStateDb('state_5.sqlite', 'complete')
    expect(readCodexStateDbBackfillStatus(home)).toEqual({ kind: 'complete', stateDbPath: dbPath })
  })

  it('reports incomplete with the raw status for running/pending', () => {
    const dbPath = createStateDb('state_5.sqlite', 'running')
    expect(readCodexStateDbBackfillStatus(home)).toEqual({
      kind: 'incomplete',
      stateDbPath: dbPath,
      status: 'running'
    })
  })

  it('reports not-tracked when the backfill_state table is absent', () => {
    const dbPath = createStateDb('state_5.sqlite')
    expect(readCodexStateDbBackfillStatus(home)).toEqual({ kind: 'not-tracked', stateDbPath: dbPath })
  })

  it('reports unreadable for a corrupt file', () => {
    const dbPath = join(home, 'state_5.sqlite')
    writeFileSync(dbPath, 'this is not a sqlite database at all')
    const result = readCodexStateDbBackfillStatus(home)
    expect(result.kind).toBe('unreadable')
  })
})

describe('countCodexSessionFilesUpTo', () => {
  it('returns 0 for a missing sessions root', () => {
    expect(countCodexSessionFilesUpTo(join(home, 'sessions'), 10)).toBe(0)
  })

  it('counts nested .jsonl files and stops at the limit', () => {
    const day = join(home, 'sessions', '2026', '07', '31')
    mkdirSync(day, { recursive: true })
    for (let i = 0; i < 7; i += 1) {
      writeFileSync(join(day, `rollout-${i}.jsonl`), '')
    }
    writeFileSync(join(day, 'not-a-session.txt'), '')
    expect(countCodexSessionFilesUpTo(join(home, 'sessions'), 100)).toBe(7)
    expect(countCodexSessionFilesUpTo(join(home, 'sessions'), 3)).toBe(3)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test src/main/codex/codex-state-db.test.ts`
Expected: FAIL — `Cannot find module './codex-state-db'` (or equivalent resolve error).

- [ ] **Step 3: Write the implementation**

Create `src/main/codex/codex-state-db.ts`:

```ts
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import SyncDatabase from '../sqlite/sync-database'

// Why: Codex versions its state DB filename per schema (state_5.sqlite today); never hardcode the number.
const STATE_DB_FILE_PATTERN = /^state_(\d+)\.sqlite$/

export type CodexStateDbBackfillStatus =
  | { kind: 'complete'; stateDbPath: string }
  | { kind: 'incomplete'; stateDbPath: string; status: string }
  | { kind: 'missing' }
  | { kind: 'not-tracked'; stateDbPath: string }
  | { kind: 'unreadable'; stateDbPath: string; error: string }

export function findNewestCodexStateDbPath(codexHomePath: string): string | null {
  let entries: string[]
  try {
    entries = readdirSync(codexHomePath)
  } catch {
    return null
  }
  let best: { version: number; name: string } | null = null
  for (const name of entries) {
    const match = STATE_DB_FILE_PATTERN.exec(name)
    if (!match) continue
    const version = Number(match[1])
    if (!best || version > best.version) {
      best = { version, name }
    }
  }
  return best ? join(codexHomePath, best.name) : null
}

/**
 * Reads Codex's session-index backfill status from the newest state DB in the
 * given Codex home. Strictly read-only: never creates, writes, or repairs the
 * DB (#11830 covers corruption from interrupted indexes; we must not add to it).
 */
export function readCodexStateDbBackfillStatus(codexHomePath: string): CodexStateDbBackfillStatus {
  const stateDbPath = findNewestCodexStateDbPath(codexHomePath)
  if (!stateDbPath) {
    return { kind: 'missing' }
  }
  let db: SyncDatabase | null = null
  try {
    db = new SyncDatabase(stateDbPath, { readonly: true, fileMustExist: true })
    const table = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'backfill_state'")
      .get()
    if (!table) {
      return { kind: 'not-tracked', stateDbPath }
    }
    const row = db.prepare('SELECT status FROM backfill_state WHERE id = 1').get() as
      | { status?: unknown }
      | undefined
    if (!row || typeof row.status !== 'string') {
      return { kind: 'not-tracked', stateDbPath }
    }
    return row.status === 'complete'
      ? { kind: 'complete', stateDbPath }
      : { kind: 'incomplete', stateDbPath, status: row.status }
  } catch (error) {
    return {
      kind: 'unreadable',
      stateDbPath,
      error: error instanceof Error ? error.message : String(error)
    }
  } finally {
    try {
      db?.close()
    } catch {
      // Why: close() failure must not mask the status we already computed.
    }
  }
}

/** Counts rollout .jsonl files under a sessions root, stopping early at `limit`. */
export function countCodexSessionFilesUpTo(sessionsRoot: string, limit: number): number {
  let count = 0
  const stack = [sessionsRoot]
  while (stack.length > 0 && count < limit) {
    const dir = stack.pop() as string
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (count >= limit) break
      if (entry.isDirectory()) {
        stack.push(join(dir, entry.name))
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        count += 1
      }
    }
  }
  return count
}
```

Note: match `SyncDatabase`'s actual option names against `src/main/sqlite/sync-database.ts`
before finishing (`readonly`, `fileMustExist`, `timeout`). If `.get()`'s return type differs,
cast via `unknown` — no `any`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test src/main/codex/codex-state-db.test.ts`
Expected: PASS (12 tests).

- [ ] **Step 5: Typecheck and commit**

```bash
pnpm tc:node
git add src/main/codex/codex-state-db.ts src/main/codex/codex-state-db.test.ts
git commit -m "feat(codex): add read-only codex state-db backfill status reader"
```

---

### Task 2: Pre-warm supervisor (`codex-state-db-prewarm.ts`)

**Files:**
- Create: `src/main/codex/codex-state-db-prewarm.ts`
- Test: `src/main/codex/codex-state-db-prewarm.test.ts`
- Read for reference (do not modify): `src/main/rate-limits/codex-fetcher.ts:568-591`, `src/main/win32-utils.ts`, `src/main/codex/codex-home-paths.ts`, `src/main/codex/codex-session-backfill-types.ts`

**Interfaces:**
- Consumes (from Task 1): `readCodexStateDbBackfillStatus(codexHomePath): CodexStateDbBackfillStatus`, `countCodexSessionFilesUpTo(sessionsRoot, limit): number`.
- Consumes (existing): `resolveCodexCommand()` from `src/main/codex-cli/command.ts` (returns `string`, fails open to `'codex'`); `getOrcaManagedCodexHomePath()` from `./codex-home-paths`; `getSpawnArgsForWindows` from `src/main/win32-utils.ts` (copy the exact call shape from `codex-fetcher.ts:576-591`); `CodexSessionBackfillOptions` (has optional `shouldStop?: () => boolean`) from `./codex-session-backfill-types`.
- Produces (used by Task 3):
  ```ts
  export type CodexStateDbPrewarmOutcome =
    | 'completed' | 'already-complete' | 'not-needed' | 'skipped-unreadable'
    | 'stopped' | 'gave-up' | 'codex-unavailable'
  export type CodexStateDbPrewarmSummary = {
    outcome: CodexStateDbPrewarmOutcome
    spawnCount: number
    elapsedMs: number
  }
  export async function runCodexStateDbPrewarm(
    codexHomePath: string,
    options?: CodexSessionBackfillOptions,
    depsOverride?: Partial<CodexStateDbPrewarmDeps>
  ): Promise<CodexStateDbPrewarmSummary>
  // Prewarms the system home (fresh real-home-lane panes) then the managed home
  // (resume-pinned panes); returns one summary per home prewarmed.
  export function startCodexStateDbPrewarmInBackground(
    options?: CodexSessionBackfillOptions,
    systemCodexHomePathOverride?: string
  ): Promise<CodexStateDbPrewarmSummary[] | null>
  ```

- [ ] **Step 1: Smoke-verify the headless command assumption (no code yet)**

The design assumes a headless `codex app-server` initializes/creates the state DB and runs
the backfill machinery. Verify against the real Codex binary on this machine, in a **temp**
home (never the real homes):

```bash
SMOKE_HOME=$(mktemp -d)
# Why sleep|: app-server reads JSON-RPC on stdin; piping sleep holds stdin open so it idles.
sleep 60 | CODEX_HOME="$SMOKE_HOME" codex -s read-only -a untrusted app-server >/dev/null 2>&1 &
sleep 15
ls -la "$SMOKE_HOME"
sqlite3 "$SMOKE_HOME"/state_*.sqlite "select status from backfill_state;" || true
wait; rm -rf "$SMOKE_HOME"
```

Expected: a `state_<N>.sqlite` exists and `backfill_state.status` prints `complete`
(empty sessions index instantly). Record the observed filename and status in the commit
message body for this task.

> Already verified during plan validation (2026-07-31, codex 0.146.0, live temp-home runs +
> openai/codex `rust-v0.146.0` source): `state_5.sqlite` created; `pending→running→complete`
> unattended; `-s read-only -a untrusted` does not block the DB writes; app-server exits on
> stdin EOF; a non-claimant exits ~30s after start. This step is now a cheap sanity re-run.
- If no state DB appears, retry with plain `codex app-server` (no `-s`/`-a` flags) and use
  whichever variant works as `PREWARM_CODEX_ARGS`.
- If neither variant creates the state DB, HALT this task and report the blocker — the
  pre-warm command choice must be re-designed; do not guess.

- [ ] **Step 2: Write the failing tests**

Create `src/main/codex/codex-state-db-prewarm.test.ts`:

```ts
import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CodexStateDbBackfillStatus } from './codex-state-db'
import {
  PREWARM_FAST_EXIT_MS,
  PREWARM_MAX_SPAWNS,
  PREWARM_MIN_SESSION_FILES,
  PREWARM_POLL_INTERVAL_MS,
  PREWARM_SPAWN_RETRY_DELAY_MS,
  runCodexStateDbPrewarm,
  type CodexStateDbPrewarmDeps
} from './codex-state-db-prewarm'

type FakeChild = ChildProcess & { kill: ReturnType<typeof vi.fn> }

function createFakeChild(): FakeChild {
  const child = new EventEmitter() as unknown as FakeChild
  child.kill = vi.fn(() => true)
  return child
}

const incomplete: CodexStateDbBackfillStatus = {
  kind: 'incomplete',
  stateDbPath: '/tmp/home/state_5.sqlite',
  status: 'running'
}
const complete: CodexStateDbBackfillStatus = {
  kind: 'complete',
  stateDbPath: '/tmp/home/state_5.sqlite'
}

function createDeps(overrides: Partial<CodexStateDbPrewarmDeps> = {}): {
  deps: Partial<CodexStateDbPrewarmDeps>
  children: FakeChild[]
  spawnProcess: ReturnType<typeof vi.fn>
} {
  const children: FakeChild[] = []
  const spawnProcess = vi.fn(() => {
    const child = createFakeChild()
    children.push(child)
    return child
  })
  const deps: Partial<CodexStateDbPrewarmDeps> = {
    resolveCommand: () => 'codex',
    spawnProcess: spawnProcess as unknown as CodexStateDbPrewarmDeps['spawnProcess'],
    readBackfillStatus: vi.fn(() => incomplete),
    countSessionFiles: vi.fn(() => PREWARM_MIN_SESSION_FILES),
    logger: { warn: vi.fn(), info: vi.fn() },
    ...overrides
  }
  return { deps, children, spawnProcess }
}

beforeEach(() => {
  vi.useFakeTimers()
})

describe('runCodexStateDbPrewarm', () => {
  it('skips without spawning when the index is already complete', async () => {
    const { deps, spawnProcess } = createDeps({ readBackfillStatus: vi.fn(() => complete) })
    const result = await runCodexStateDbPrewarm('/tmp/home', {}, deps)
    expect(result.outcome).toBe('already-complete')
    expect(spawnProcess).not.toHaveBeenCalled()
  })

  it('skips when there is no state db and the session history is small', async () => {
    const { deps, spawnProcess } = createDeps({
      readBackfillStatus: vi.fn(() => ({ kind: 'missing' }) as CodexStateDbBackfillStatus),
      countSessionFiles: vi.fn(() => 3)
    })
    const result = await runCodexStateDbPrewarm('/tmp/home', {}, deps)
    expect(result.outcome).toBe('not-needed')
    expect(spawnProcess).not.toHaveBeenCalled()
  })

  it('skips with a warning when the state db is unreadable', async () => {
    const warn = vi.fn()
    const { deps, spawnProcess } = createDeps({
      readBackfillStatus: vi.fn(
        () =>
          ({ kind: 'unreadable', stateDbPath: '/tmp/home/state_5.sqlite', error: 'locked' }) as CodexStateDbBackfillStatus
      ),
      logger: { warn, info: vi.fn() }
    })
    const result = await runCodexStateDbPrewarm('/tmp/home', {}, deps)
    expect(result.outcome).toBe('skipped-unreadable')
    expect(spawnProcess).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalled()
  })

  it('supervises a codex child until the status flips to complete, then kills it', async () => {
    const statuses = [incomplete, incomplete, incomplete, complete]
    const readBackfillStatus = vi.fn(() => statuses.shift() ?? complete)
    const { deps, children } = createDeps({ readBackfillStatus })
    const task = runCodexStateDbPrewarm('/tmp/home', {}, deps)
    await vi.advanceTimersByTimeAsync(PREWARM_POLL_INTERVAL_MS * 4)
    const result = await task
    expect(result.outcome).toBe('completed')
    expect(result.spawnCount).toBe(1)
    expect(children[0].kill).toHaveBeenCalled()
  })

  it('respawns on fast child deaths and gives up after the fast-failure budget', async () => {
    const { deps, children, spawnProcess } = createDeps()
    const task = runCodexStateDbPrewarm('/tmp/home', {}, deps)
    for (let i = 0; i < PREWARM_MAX_SPAWNS; i += 1) {
      // Why < PREWARM_FAST_EXIT_MS: a child dying before codex's own 30s backfill gate
      // is a real failure and must burn budget.
      await vi.advanceTimersByTimeAsync(PREWARM_POLL_INTERVAL_MS)
      children[children.length - 1].emit('exit', 1, null)
      await vi.advanceTimersByTimeAsync(PREWARM_SPAWN_RETRY_DELAY_MS + PREWARM_POLL_INTERVAL_MS)
    }
    const result = await task
    expect(result.outcome).toBe('gave-up')
    expect(spawnProcess).toHaveBeenCalledTimes(PREWARM_MAX_SPAWNS)
  })

  it('treats ~30s claim-blocked exits as expected and keeps respawning past the budget', async () => {
    // Why: verified codex 0.146 behavior — a non-claimant app-server exits ~30s after
    // start (foreign or stale backfill lease, self-healing within 900s); such exits
    // must NOT count toward PREWARM_MAX_SPAWNS.
    const statuses: CodexStateDbBackfillStatus[] = []
    const readBackfillStatus = vi.fn(() => statuses.shift() ?? incomplete)
    const { deps, children, spawnProcess } = createDeps({ readBackfillStatus })
    const task = runCodexStateDbPrewarm('/tmp/home', {}, deps)
    for (let i = 0; i < PREWARM_MAX_SPAWNS + 2; i += 1) {
      await vi.advanceTimersByTimeAsync(PREWARM_FAST_EXIT_MS * 3)
      children[children.length - 1].emit('exit', 1, null)
      await vi.advanceTimersByTimeAsync(PREWARM_SPAWN_RETRY_DELAY_MS)
    }
    expect(spawnProcess.mock.calls.length).toBeGreaterThan(PREWARM_MAX_SPAWNS)
    statuses.push(complete)
    await vi.advanceTimersByTimeAsync(PREWARM_POLL_INTERVAL_MS)
    const result = await task
    expect(result.outcome).toBe('completed')
  })

  it('stops and kills the child when shouldStop flips true', async () => {
    const { deps, children } = createDeps()
    let stop = false
    const task = runCodexStateDbPrewarm('/tmp/home', { shouldStop: () => stop }, deps)
    await vi.advanceTimersByTimeAsync(PREWARM_POLL_INTERVAL_MS)
    stop = true
    await vi.advanceTimersByTimeAsync(PREWARM_POLL_INTERVAL_MS)
    const result = await task
    expect(result.outcome).toBe('stopped')
    expect(children[0].kill).toHaveBeenCalled()
  })

  it('reports codex-unavailable when the first spawn errors (ENOENT)', async () => {
    const { deps, children } = createDeps()
    const task = runCodexStateDbPrewarm('/tmp/home', {}, deps)
    await vi.advanceTimersByTimeAsync(0)
    children[0].emit('error', new Error('spawn codex ENOENT'))
    await vi.advanceTimersByTimeAsync(PREWARM_POLL_INTERVAL_MS)
    const result = await task
    expect(result.outcome).toBe('codex-unavailable')
  })
})
```

Adjust timer-advance amounts if the loop shape needs it, but keep the assertions.

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm test src/main/codex/codex-state-db-prewarm.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Write the implementation**

Create `src/main/codex/codex-state-db-prewarm.ts`:

```ts
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import { resolveCodexCommand } from '../codex-cli/command'
import { getOrcaManagedCodexHomePath } from './codex-home-paths'
import type { CodexSessionBackfillOptions } from './codex-session-backfill-types'
import {
  countCodexSessionFilesUpTo,
  readCodexStateDbBackfillStatus,
  type CodexStateDbBackfillStatus
} from './codex-state-db'

// Why: mirrors codex-fetcher's headless invocation; app-server idles on stdin and runs
// Codex's startup state-db backfill without needing a TUI or a model turn.
export const PREWARM_CODEX_ARGS: readonly string[] = ['-s', 'read-only', '-a', 'untrusted', 'app-server']
// Why: small histories index within Codex's own 30s startup wait; only pre-warm large ones.
export const PREWARM_MIN_SESSION_FILES = 100
export const PREWARM_POLL_INTERVAL_MS = 5_000
export const PREWARM_SPAWN_RETRY_DELAY_MS = 2_000
// Why: verified codex 0.146 — a non-claimant app-server exits ~30s after start (another
// process holds the backfill lease, or a stale lease <=900s after an unclean kill). Those
// exits are expected and self-heal; only children dying before codex's own 30s gate
// (< PREWARM_FAST_EXIT_MS) count as failures.
export const PREWARM_FAST_EXIT_MS = 10_000
export const PREWARM_MAX_SPAWNS = 5 // budget for fast failures only; deadline bounds the rest
// Why: reporter's 15 GB history took ~25 min; 60 min bounds pathological cases.
export const PREWARM_MAX_TOTAL_MS = 60 * 60_000

export type CodexStateDbPrewarmOutcome =
  | 'completed'
  | 'already-complete'
  | 'not-needed'
  | 'skipped-unreadable'
  | 'stopped'
  | 'gave-up'
  | 'codex-unavailable'

export type CodexStateDbPrewarmSummary = {
  outcome: CodexStateDbPrewarmOutcome
  spawnCount: number
  elapsedMs: number
}

export type CodexStateDbPrewarmDeps = {
  resolveCommand: () => string
  spawnProcess: typeof spawn
  readBackfillStatus: (codexHomePath: string) => CodexStateDbBackfillStatus
  countSessionFiles: (sessionsRoot: string, limit: number) => number
  now: () => number
  sleep: (ms: number) => Promise<void>
  logger: Pick<Console, 'warn' | 'info'>
}

const defaultDeps: CodexStateDbPrewarmDeps = {
  resolveCommand: () => resolveCodexCommand(),
  spawnProcess: spawn,
  readBackfillStatus: readCodexStateDbBackfillStatus,
  countSessionFiles: countCodexSessionFilesUpTo,
  now: Date.now,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  logger: console
}

/**
 * Keeps a hidden headless codex alive against `codexHomePath` until Codex's
 * one-time session index (backfill_state in state_<N>.sqlite) reads complete.
 * Without this, panes only give the index 30s slices and it never finishes
 * on large histories (#11828). Local homes only — SSH remotes are out of scope.
 */
export async function runCodexStateDbPrewarm(
  codexHomePath: string,
  options: CodexSessionBackfillOptions = {},
  depsOverride: Partial<CodexStateDbPrewarmDeps> = {}
): Promise<CodexStateDbPrewarmSummary> {
  const deps: CodexStateDbPrewarmDeps = { ...defaultDeps, ...depsOverride }
  const startedAt = deps.now()
  const finish = (outcome: CodexStateDbPrewarmOutcome, spawnCount: number): CodexStateDbPrewarmSummary => ({
    outcome,
    spawnCount,
    elapsedMs: deps.now() - startedAt
  })
  const shouldStop = (): boolean => options.shouldStop?.() === true

  const status = deps.readBackfillStatus(codexHomePath)
  if (status.kind === 'complete') return finish('already-complete', 0)
  if (status.kind === 'not-tracked') return finish('not-needed', 0)
  if (status.kind === 'unreadable') {
    // Why: never spawn against a DB we cannot even read — #11830's corruption path.
    deps.logger.warn(
      `[codex-state-db-prewarm] state db unreadable at ${status.stateDbPath}; skipping prewarm: ${status.error}`
    )
    return finish('skipped-unreadable', 0)
  }
  if (
    status.kind === 'missing' &&
    deps.countSessionFiles(join(codexHomePath, 'sessions'), PREWARM_MIN_SESSION_FILES) <
      PREWARM_MIN_SESSION_FILES
  ) {
    return finish('not-needed', 0)
  }

  deps.logger.info(
    `[codex-state-db-prewarm] pre-warming codex session index at ${codexHomePath} (this can take minutes on large histories)`
  )
  const deadline = startedAt + PREWARM_MAX_TOTAL_MS
  let spawnCount = 0
  let fastFailureCount = 0
  while (true) {
    if (shouldStop()) return finish('stopped', spawnCount)
    if (deps.now() >= deadline || fastFailureCount >= PREWARM_MAX_SPAWNS) {
      deps.logger.warn(
        `[codex-state-db-prewarm] giving up after ${spawnCount} spawn(s); index still incomplete`
      )
      return finish('gave-up', spawnCount)
    }
    const child = spawnPrewarmCodex(codexHomePath, deps)
    const spawnedAt = deps.now()
    spawnCount += 1
    let childDown = false
    let spawnFailed = false
    child.once('error', (error) => {
      childDown = true
      spawnFailed = true
      deps.logger.warn('[codex-state-db-prewarm] codex spawn failed:', error)
    })
    child.once('exit', () => {
      childDown = true
    })

    while (!childDown) {
      await deps.sleep(PREWARM_POLL_INTERVAL_MS)
      if (shouldStop()) {
        terminate(child)
        return finish('stopped', spawnCount)
      }
      const polled = deps.readBackfillStatus(codexHomePath)
      if (polled.kind === 'complete') {
        terminate(child)
        deps.logger.info('[codex-state-db-prewarm] codex session index complete')
        return finish('completed', spawnCount)
      }
      if (deps.now() >= deadline) {
        terminate(child)
        return finish('gave-up', spawnCount)
      }
    }
    if (spawnFailed && spawnCount === 1) {
      // Why: first spawn ENOENT means no usable codex binary; retries cannot help.
      return finish('codex-unavailable', spawnCount)
    }
    // Why: claim-blocked exits (~30s, verified) are expected — respawn until the
    // deadline; only fast deaths burn the failure budget.
    if (deps.now() - spawnedAt < PREWARM_FAST_EXIT_MS) {
      fastFailureCount += 1
    }
    await deps.sleep(PREWARM_SPAWN_RETRY_DELAY_MS)
  }
}

function terminate(child: ChildProcess): void {
  try {
    // Why: app-server exits promptly on stdin EOF once initialized — try that first.
    child.stdin?.end()
    if (process.platform === 'win32') {
      // Why: child.kill() only reaches the .cmd/cmd.exe wrapper on Windows and orphans
      // codex.exe — kill the tree. Reuse (extract if needed) the existing
      // killCodexAppServerProcessTree() from src/main/codex/codex-app-server-session.ts:58-91.
      killCodexAppServerProcessTree(child)
      return
    }
    // Why: a mid-index claimer blocks in init before the stdin transport runs, so EOF
    // alone may not stop it. SIGTERM never corrupts the DB (verified), but leaves a
    // stale backfill lease: codex starts against this home fail at ~30s for <=900s,
    // then the next claimer resumes from the watermark.
    child.kill()
  } catch {
    // Why: the child may exit between the poll and the kill.
  }
}

function spawnPrewarmCodex(codexHomePath: string, deps: CodexStateDbPrewarmDeps): ChildProcess {
  // NOTE: copy the exact getSpawnArgsForWindows call shape from
  // src/main/rate-limits/codex-fetcher.ts:576-591 (win32 .cmd/.bat launchers).
  const command = deps.resolveCommand()
  return deps.spawnProcess(command, [...PREWARM_CODEX_ARGS], {
    cwd: codexHomePath,
    // Why: hold stdin open so app-server idles instead of exiting on stdin EOF; never write to it.
    stdio: ['pipe', 'ignore', 'ignore'],
    windowsHide: true,
    env: { ...process.env, CODEX_HOME: codexHomePath }
  })
}

/**
 * Prewarms both local homes panes actually use, in order:
 * 1. the system home (fresh panes on the real-home lane read it — same target the
 *    index-heal stage pins; resolve the default exactly the way index-heal does when
 *    the override is undefined), then
 * 2. the managed home (resume-pinned panes read it).
 * Why both: with the real-home lane selected, fresh panes get NO managed CODEX_HOME
 * (runtime-home-service.ts:175-181 returns null) — see ledger A10/AD-3.
 */
async function runDualHomePrewarm(
  options: CodexSessionBackfillOptions,
  systemCodexHomePathOverride?: string
): Promise<CodexStateDbPrewarmSummary[]> {
  // NOTE: reuse the exact system-home fallback resolution the index-heal stage uses
  // (see src/main/codex/codex-session-index-heal.ts) when the override is undefined.
  const systemHome = systemCodexHomePathOverride ?? resolveDefaultSystemCodexHomePath()
  const managedHome = getOrcaManagedCodexHomePath()
  const homes = [systemHome, managedHome].filter(
    (home, index, all): home is string => typeof home === 'string' && all.indexOf(home) === index
  )
  const summaries: CodexStateDbPrewarmSummary[] = []
  for (const home of homes) {
    if (options.shouldStop?.() === true) break
    summaries.push(await runCodexStateDbPrewarm(home, options))
  }
  return summaries
}

let backgroundPrewarmTask: Promise<CodexStateDbPrewarmSummary[] | null> | null = null

/** Single-flight background wrapper matching the migration-scheduler MigrationRun shape. */
export function startCodexStateDbPrewarmInBackground(
  options: CodexSessionBackfillOptions = {},
  systemCodexHomePathOverride?: string
): Promise<CodexStateDbPrewarmSummary[] | null> {
  if (backgroundPrewarmTask) return backgroundPrewarmTask
  const task = runDualHomePrewarm(options, systemCodexHomePathOverride)
    .catch((error: unknown) => {
      console.warn('[codex-state-db-prewarm] Background prewarm failed:', error)
      return null
    })
    .finally(() => {
      if (backgroundPrewarmTask === task) backgroundPrewarmTask = null
    })
  backgroundPrewarmTask = task
  return task
}
```

Implementation notes (do these while writing, they are part of this step):
- Wire `getSpawnArgsForWindows` exactly as `codex-fetcher.ts:576-591` does (import from
  `src/main/win32-utils.ts`) so Windows `.cmd`/`.bat` shims spawn correctly; keep `windowsHide: true`.
- If the smoke check in Step 1 selected different args, set `PREWARM_CODEX_ARGS` accordingly.
- Confirm `CodexSessionBackfillOptions` in `codex-session-backfill-types.ts` really carries
  `shouldStop?: () => boolean`; if the field name differs, use the actual name everywhere in
  this plan's code (Tasks 2-3).
- `killCodexAppServerProcessTree` lives in `src/main/codex/codex-app-server-session.ts:58-91`
  (`taskkill /pid <pid> /t /f`); export it (or extract a shared helper) rather than copying —
  bare `child.kill()` on Windows only kills the `.cmd`/`cmd.exe` wrapper (repo documents this
  in `codex-accounts/service.ts:204` and `commit-message-text-generation.ts:493`).
- Resolve the default system home (when the override is undefined) the same way the
  index-heal stage does — find and reuse its helper, do not invent a new path.
- Keep the file under 300 lines; if the dual-home wrapper pushes it over, split the
  supervisor loop and the wrapper into two domain-named files.

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm test src/main/codex/codex-state-db-prewarm.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 6: Typecheck and commit**

```bash
pnpm tc:node
git add src/main/codex/codex-state-db-prewarm.ts src/main/codex/codex-state-db-prewarm.test.ts
git commit -m "feat(codex): supervise headless codex to pre-warm managed-home session index"
```

Include the Step 1 smoke observations in the commit body.

---

### Task 3: Chain pre-warm into the migration scheduler and wire it in `index.ts`

**Files:**
- Modify: `src/main/codex/codex-session-migration-scheduler.ts` (87 lines; chain logic at ~:26-69)
- Modify: `src/main/codex/codex-session-migration-scheduler.test.ts`
- Modify: `src/main/index.ts:2082-2103` (the `createCodexSessionMigrationScheduler` call)

**Interfaces:**
- Consumes (from Task 2): `startCodexStateDbPrewarmInBackground(options, systemCodexHomePathOverride?): Promise<CodexStateDbPrewarmSummary[] | null>` — matches the scheduler's `MigrationRun` type `(options: CodexSessionBackfillOptions, systemCodexHomePathOverride?: string) => Promise<unknown>`. Unlike the original sketch, the wrapper genuinely uses `systemCodexHomePathOverride`: it prewarms the system home first, then the managed home (ledger A10/AD-3).
- Produces: `createCodexSessionMigrationScheduler` gains a required arg `startStateDbPrewarm: MigrationRun`; chain order is backfill → index-heal → prewarm, with stop-propagation.

- [ ] **Step 1: Write the failing tests**

In `src/main/codex/codex-session-migration-scheduler.test.ts`, first add
`startStateDbPrewarm: vi.fn(async () => null)` to every existing scheduler construction
(follow the file's existing factory/arg style), then add these cases (adapt helper names to
the file's existing ones — it already has helpers to flush the chain):

```ts
it('runs the state-db prewarm after backfill and index-heal complete', async () => {
  const order: string[] = []
  const scheduler = createCodexSessionMigrationScheduler({
    isEligible: () => true,
    isQuitting: () => false,
    resolveSystemCodexHomePathOverride: () => undefined,
    startBackfill: vi.fn(async () => {
      order.push('backfill')
      return null
    }),
    startIndexHeal: vi.fn(async () => {
      order.push('heal')
      return null
    }),
    startStateDbPrewarm: vi.fn(async () => {
      order.push('prewarm')
      return null
    }),
    initialDelayMs: 0
  })
  scheduler.requestRun()
  await vi.waitFor(() => expect(order).toEqual(['backfill', 'heal', 'prewarm']))
})

it('skips the prewarm when the backfill run was stopped', async () => {
  const startStateDbPrewarm = vi.fn(async () => null)
  const scheduler = createCodexSessionMigrationScheduler({
    isEligible: () => true,
    isQuitting: () => false,
    resolveSystemCodexHomePathOverride: () => undefined,
    // Why: mirror the shape isStoppedMigrationResult() recognizes — copy it from an
    // existing "stopped" case in this test file.
    startBackfill: vi.fn(async () => ({ stopped: true })),
    startIndexHeal: vi.fn(async () => null),
    startStateDbPrewarm,
    initialDelayMs: 0
  })
  scheduler.requestRun()
  await vi.waitFor(() => expect(startStateDbPrewarm).not.toHaveBeenCalled())
})
```

Important: read the existing test file first and reuse its established way of (a) building
scheduler args and (b) representing a "stopped" migration result — `isStoppedMigrationResult`
has an exact shape the existing tests already exercise.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test src/main/codex/codex-session-migration-scheduler.test.ts`
Expected: FAIL — TypeScript/arg error for the new `startStateDbPrewarm` property and the two
new assertions.

- [ ] **Step 3: Implement the scheduler change**

In `codex-session-migration-scheduler.ts`:

1. Add `startStateDbPrewarm: MigrationRun` to the `createCodexSessionMigrationScheduler` args type.
2. Extend the chain (currently `startBackfill → startIndexHeal`) so the heal stage's result
   gates the prewarm:

```ts
const task = args
  .startBackfill({ shouldStop }, systemCodexHomePathOverride)
  .then((result) => {
    stoppedBackfill = isStoppedMigrationResult(result)
    if (stoppedBackfill || shouldStop()) {
      return
    }
    return args.startIndexHeal({ shouldStop }, systemCodexHomePathOverride).then((healResult) => {
      if (isStoppedMigrationResult(healResult) || shouldStop()) {
        return
      }
      // Why: prewarm last — it babysits a codex process for minutes and must never
      // delay the session backfill/heal walks it depends on.
      return args.startStateDbPrewarm({ shouldStop }, systemCodexHomePathOverride).then(() => undefined)
    })
  })
  .catch((error: unknown) => {
    console.warn('[codex-session-migration] Background session migration failed:', error)
  })
  .then(() => undefined)
```

Preserve the existing `rerunRequested || stoppedBackfill` re-run logic untouched.

- [ ] **Step 4: Wire in `src/main/index.ts`**

At the `createCodexSessionMigrationScheduler` call (~:2082-2097), add the import and arg:

```ts
import { startCodexStateDbPrewarmInBackground } from './codex/codex-state-db-prewarm'
```

```ts
  const codexSessionMigration = createCodexSessionMigrationScheduler({
    isEligible: () => codexRuntimeHome?.isHostSystemDefaultRealHome() === true,
    isQuitting: () => isQuitting,
    resolveSystemCodexHomePathOverride: () =>
      resolveHostCodexSessionSourceHome(store!.getSettings()),
    startBackfill: startCodexSessionBackfillInBackground,
    startIndexHeal: startCodexSessionIndexHealInBackground,
    // Why: #11828 — finish Codex's one-time session index in the background so panes
    // don't die in 30s slices against a large managed-home history.
    startStateDbPrewarm: startCodexStateDbPrewarmInBackground
  })
```

Match the surrounding style exactly; do not reorder existing properties.

Quit behavior (verify while wiring, part of this step): the scheduler's `shouldStop` must
flip when the app quits (its existing `isQuitting` wiring) so the prewarm's 5s poll
terminates the child; note that `app.exit(0)` paths skip `before-quit` (`src/main/ipc/app.ts:286`)
and the repo's explicit quit hooks live at `src/main/index.ts:2810-2831` — if the scheduler
is not already stopped from that path, add the stop call there. An orphan that survives quit
self-exits on stdin EOF after init; a mid-index orphan finishes the index then exits
(benign — verified lease semantics, ledger A11/A2).

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm test src/main/codex/codex-session-migration-scheduler.test.ts`
Expected: PASS (existing tests plus the 2 new ones).

Run: `pnpm tc:node`
Expected: no errors (proves the `index.ts` wiring typechecks).

- [ ] **Step 6: Commit**

```bash
git add src/main/codex/codex-session-migration-scheduler.ts src/main/codex/codex-session-migration-scheduler.test.ts src/main/index.ts
git commit -m "fix(codex): chain state-db prewarm after session backfill and index heal (#11828)"
```

---

### Task 4: Renderer backfill-failure detector module

**Files:**
- Create: `src/renderer/src/components/terminal-pane/codex-backfill-error-detector.ts`
- Test: `src/renderer/src/components/terminal-pane/codex-backfill-error-detector.test.ts`

**Interfaces:**
- Produces (used by Tasks 5-6):
  ```ts
  export const CODEX_BACKFILL_TIMEOUT_SIGNATURE = 'timed out waiting for state db backfill'
  export const CODEX_BACKFILL_INDEXING_NOTICE: string // starts with 'Codex is still indexing your session history'
  export type CodexBackfillErrorDetector = { observe(chunk: string): string | null }
  export function createCodexBackfillErrorDetector(): CodexBackfillErrorDetector
  ```

- [ ] **Step 1: Write the failing tests**

Create `codex-backfill-error-detector.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import {
  CODEX_BACKFILL_INDEXING_NOTICE,
  createCodexBackfillErrorDetector
} from './codex-backfill-error-detector'

const FAILURE_OUTPUT =
  'state db backfill is running at /home/dan/.local/share/orca/codex-runtime-home/home; ' +
  'waiting up to 30s before retrying startup initialization\r\n' +
  "Codex couldn't start because its local database appears to be damaged.\r\n" +
  'timed out waiting for state db backfill at ' +
  '/home/dan/.local/share/orca/codex-runtime-home/home/state_5.sqlite after 30s (status: running)\r\n'

describe('createCodexBackfillErrorDetector', () => {
  it('fires the notice when the timeout signature appears in one chunk', () => {
    const detector = createCodexBackfillErrorDetector()
    expect(detector.observe(FAILURE_OUTPUT)).toBe(CODEX_BACKFILL_INDEXING_NOTICE)
  })

  it('fires when the signature is split across chunks', () => {
    const detector = createCodexBackfillErrorDetector()
    const mid = Math.floor(FAILURE_OUTPUT.length / 2)
    expect(detector.observe(FAILURE_OUTPUT.slice(0, mid))).toBeNull()
    expect(detector.observe(FAILURE_OUTPUT.slice(mid))).toBe(CODEX_BACKFILL_INDEXING_NOTICE)
  })

  it('fires despite interleaved ANSI escapes', () => {
    const detector = createCodexBackfillErrorDetector()
    const noisy = FAILURE_OUTPUT.replace(/state db/g, '\u001b[31mstate\u001b[0m db')
    expect(detector.observe(noisy)).toBe(CODEX_BACKFILL_INDEXING_NOTICE)
  })

  it('fires at most once', () => {
    const detector = createCodexBackfillErrorDetector()
    expect(detector.observe(FAILURE_OUTPUT)).toBe(CODEX_BACKFILL_INDEXING_NOTICE)
    expect(detector.observe(FAILURE_OUTPUT)).toBeNull()
  })

  it('stays silent for ordinary output and for the non-fatal waiting line alone', () => {
    const detector = createCodexBackfillErrorDetector()
    expect(detector.observe('hello world\r\n')).toBeNull()
    expect(
      detector.observe('state db backfill is running at /x; waiting up to 30s before retrying\r\n')
    ).toBeNull()
  })

  it('does not fire on a generic damaged-database error without the backfill timeout', () => {
    const detector = createCodexBackfillErrorDetector()
    expect(
      detector.observe("Codex couldn't start because its local database appears to be damaged.\r\n")
    ).toBeNull()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test src/renderer/src/components/terminal-pane/codex-backfill-error-detector.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `codex-backfill-error-detector.ts`:

```ts
// Why: 'database appears to be damaged' alone can be a real corruption; only the
// backfill-timeout line is unambiguous for the #11828 large-history startup race.
export const CODEX_BACKFILL_TIMEOUT_SIGNATURE = 'timed out waiting for state db backfill'

export const CODEX_BACKFILL_INDEXING_NOTICE = [
  'Codex is still indexing your session history and could not start yet.',
  'Codex reports this as a damaged local database, but the database is fine — its one-time session index takes a while on a large history and Codex only waits 30 seconds at startup.',
  // Why the hedged phrasing: not every configuration gets the background prewarm
  // (ledger AD-3); leaving a codex pane open also finishes the index (codex resumes
  // the claim itself), so the advice must be honest for all lanes.
  'Orca finishes the index in the background when it can; leaving one Codex pane open also lets Codex finish it. Retry in a few minutes.'
].join('\n')

// Why: strip CSI/OSC escapes so a redraw-heavy TUI cannot split the signature text.
const ANSI_ESCAPE_PATTERN = /\u001b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)?)/g
const DETECTOR_BUFFER_MAX_CHARS = 4096

export type CodexBackfillErrorDetector = { observe(chunk: string): string | null }

/** One-shot scanner over a pane's output stream for Codex's backfill-timeout failure. */
export function createCodexBackfillErrorDetector(): CodexBackfillErrorDetector {
  let tail = ''
  let armed = true
  return {
    observe(chunk: string): string | null {
      if (!armed) return null
      const normalized = (tail + chunk).replace(ANSI_ESCAPE_PATTERN, '').replace(/\r/g, '')
      tail = normalized.slice(-DETECTOR_BUFFER_MAX_CHARS)
      if (!tail.includes(CODEX_BACKFILL_TIMEOUT_SIGNATURE)) return null
      armed = false
      return CODEX_BACKFILL_INDEXING_NOTICE
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test src/renderer/src/components/terminal-pane/codex-backfill-error-detector.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/components/terminal-pane/codex-backfill-error-detector.ts src/renderer/src/components/terminal-pane/codex-backfill-error-detector.test.ts
git commit -m "feat(terminal): detect codex state-db backfill timeout in pane output"
```

---

### Task 5: Toast classifier and informational styling

**Files:**
- Modify: `src/renderer/src/components/terminal-pane/TerminalErrorToast.tsx`
- Modify: `src/renderer/src/components/terminal-pane/TerminalErrorToast.test.ts`

**Interfaces:**
- Consumes (from Task 4): the notice's stable first line `'Codex is still indexing your session history'`.
- Produces:
  ```ts
  export function isCodexBackfillIndexingNotice(error: string): boolean
  ```

- [ ] **Step 1: Write the failing tests**

Add to `TerminalErrorToast.test.ts` (match the file's existing import/describe style — it
already tests the other pure classifier exports):

```ts
import { CODEX_BACKFILL_INDEXING_NOTICE } from './codex-backfill-error-detector'
// add isCodexBackfillIndexingNotice to the existing import from './TerminalErrorToast'

describe('isCodexBackfillIndexingNotice', () => {
  it('recognizes the codex indexing notice', () => {
    expect(isCodexBackfillIndexingNotice(CODEX_BACKFILL_INDEXING_NOTICE)).toBe(true)
  })

  it('recognizes it inside an accumulated multi-error string', () => {
    expect(isCodexBackfillIndexingNotice(`something else\n${CODEX_BACKFILL_INDEXING_NOTICE}`)).toBe(true)
  })

  it('rejects unrelated errors', () => {
    expect(isCodexBackfillIndexingNotice('SSH connection is not active')).toBe(false)
    expect(isCodexBackfillIndexingNotice('node-pty: posix_spawn failed: ENOENT')).toBe(false)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test src/renderer/src/components/terminal-pane/TerminalErrorToast.test.ts`
Expected: FAIL — `isCodexBackfillIndexingNotice` is not exported.

- [ ] **Step 3: Implement**

In `TerminalErrorToast.tsx`:

1. Add the classifier next to the existing exported classifiers
   (`isSshReconnectOwnedTerminalError`, `shouldOfferDaemonRestart`):

```ts
/** True when the pane error is Orca's informational codex-indexing notice (#11828). */
export function isCodexBackfillIndexingNotice(error: string): boolean {
  return error.includes('Codex is still indexing your session history')
}
```

2. Use it in the render: the component currently picks between an amber (SSH) palette and a
   red default palette, and the red path frames the message as a failure (file-an-issue /
   daemon-restart affordances). Route `isCodexBackfillIndexingNotice(error)` to the **amber
   informational treatment**: amber palette, no "file an issue"-style suffix, and no daemon
   restart button (add `&& !isCodexBackfillIndexingNotice(error)` to the same condition that
   already gates the restart affordance alongside the SSH check). Keep the dismiss button.
   Follow the exact conditional structure already in the file — this is a two-to-three-line
   change to existing ternaries, not a redesign.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test src/renderer/src/components/terminal-pane/TerminalErrorToast.test.ts`
Expected: PASS (existing tests plus 3 new).

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/components/terminal-pane/TerminalErrorToast.tsx src/renderer/src/components/terminal-pane/TerminalErrorToast.test.ts
git commit -m "feat(terminal): render codex indexing notice as informational toast"
```

---

### Task 6: Wire the detector into `pty-connection.ts`

**Files:**
- Modify: `src/renderer/src/components/terminal-pane/pty-connection.ts` (detector instance near the other per-connection scanners; observation in `dataCallback`'s scanner band at ~:7275-7308)
- Modify: `src/renderer/src/components/terminal-pane/pty-connection.test.ts`

**Interfaces:**
- Consumes (from Task 4): `createCodexBackfillErrorDetector()`.
- Consumes (existing, all already in scope inside `pty-connection.ts`):
  - `dataCallback(data: string, meta?: PtyDataMeta, streamGeneration?)` at `:7217` — the per-pane incoming-data handler with an existing band of string scanners at `:7275-7308` (`scanForShellReadyMarker`, `observeStartupDraftPasteReadiness`, `observeTerminalGitHubPRLink`, `commandCodeOutputStatusDetector.observe`).
  - `resolveExpectedLaunchTuiAgent(): TuiAgent | null` at `:1967` — `'codex'` identifies codex panes.
  - `reportError(message: string)` at `:4448` — routes to `TerminalPane`'s error state (the toast); do NOT call `deps.onPtyErrorRef` directly (reportError carries the disposed/worktree-fence guards).
- Produces: user-visible behavior — a codex pane whose output contains the backfill-timeout signature shows the informational toast.

- [ ] **Step 1: Write the failing tests**

In `pty-connection.test.ts`: find the canonical data-callback test at ~`:2283` — it mocks
`./pty-transport`, captures `callbacks.onData` from `transport.connect.mockImplementation`,
and invokes it with a literal string. Copy that test's full setup (connection construction,
transport mock, any store seeding) for two new tests, adjusting only what is listed below.
Also find how existing tests in this file mark a pane as a codex launch (search the file for
`launchAgent` and `'codex'`) and reuse that exact mechanism.

```ts
import { CODEX_BACKFILL_INDEXING_NOTICE } from './codex-backfill-error-detector'

const CODEX_BACKFILL_FAILURE_OUTPUT =
  "Codex couldn't start because its local database appears to be damaged.\r\n" +
  'timed out waiting for state db backfill at /x/state_5.sqlite after 30s (status: running)\r\n'

it('surfaces the codex indexing notice when a codex pane hits the backfill timeout', async () => {
  // setup: copy from the canonical onData test at ~:2283, with the pane marked as a
  // codex launch (launchAgent 'codex') and an onPtyError spy captured the way the
  // file's existing error tests capture it.
  onData(CODEX_BACKFILL_FAILURE_OUTPUT.slice(0, 40))
  onData(CODEX_BACKFILL_FAILURE_OUTPUT.slice(40))
  expect(onPtyError).toHaveBeenCalledWith(expect.anything(), CODEX_BACKFILL_INDEXING_NOTICE)
  expect(onPtyError).toHaveBeenCalledTimes(1)
})

it('does not surface the notice for non-codex panes', async () => {
  // setup: same, but with no codex launch agent (plain shell pane).
  onData(CODEX_BACKFILL_FAILURE_OUTPUT)
  expect(onPtyError).not.toHaveBeenCalled()
})
```

These two bodies are the required assertions; the surrounding setup must mirror the file's
existing tests verbatim (that file is 800-line-budget-exempt via the test budget — it is a
`.test.ts`, budget 800, and already large; if the ratchet complains, put the two tests in a
new co-located file `pty-connection-codex-backfill.test.ts` using the same setup imports).

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test src/renderer/src/components/terminal-pane/pty-connection.test.ts`
Expected: the two new tests FAIL (no notice raised); existing tests still pass.

- [ ] **Step 3: Implement the wiring**

In `pty-connection.ts`:

1. Import and instantiate one detector per connection, next to where the other scanner
   state (e.g. `commandCodeOutputStatusDetector`) is created:

```ts
import { createCodexBackfillErrorDetector } from './codex-backfill-error-detector'
```

```ts
const codexBackfillErrorDetector = createCodexBackfillErrorDetector()
```

2. In `dataCallback`, at the end of the existing scanner band (immediately after the
   `commandCodeOutputStatusDetector.observe` call at ~`:7308` — later insertion points sit
   behind early returns):

```ts
// Why: #11828 — codex exits with a misleading "damaged database" error while its
// one-time session index runs; translate it to what is actually happening.
if (resolveExpectedLaunchTuiAgent() === 'codex') {
  const codexBackfillNotice = codexBackfillErrorDetector.observe(data)
  if (codexBackfillNotice) {
    reportError(codexBackfillNotice)
  }
}
```

Keep the observe call cheap-path-first exactly as shown (agent check before observe) so
non-codex panes pay nothing.

Detection scope (validated; document in a brief comment if natural): this covers **visible,
Orca-launched** codex panes — `tab.launchAgent` is set at tab creation, pre-spawn, so there
is no agent-resolution race. Accepted misses (ledger AD-4): hidden/background panes receive
no renderer bytes (`pty-connection.ts:7405`, hidden-delivery gate `:5875-5904`), flood-dropped
chunks are restored via snapshot (bypassing `dataCallback`), and manually-typed `codex` in a
plain shell pane has no `launchAgent`. The prewarm (half A) still fixes those homes whether
or not the toast fires.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test src/renderer/src/components/terminal-pane/pty-connection.test.ts`
Expected: PASS, including the two new tests.

Also run the neighboring suites to catch regressions:
`pnpm test src/renderer/src/components/terminal-pane/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/components/terminal-pane/pty-connection.ts src/renderer/src/components/terminal-pane/pty-connection.test.ts
git commit -m "fix(terminal): explain codex backfill-timeout startup failures in the pane (#11828)"
```

(If Step 1 created `pty-connection-codex-backfill.test.ts`, add that path instead.)

---

### Task 7: Full gates and on-machine end-to-end verification

**Files:**
- No new source files. Read-only inspection of real homes; disposable temp user-data dir.

**Interfaces:**
- Consumes: everything above, plus the real environment on this machine (WSL2; managed home `/home/dan/.local/share/orca/codex-runtime-home/home`; real `~/.codex` with ~4.8k rollout files, 15 GB — hardlink-shared with the managed home).

- [ ] **Step 1: Run all four gates**

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm build
```

Expected: all pass. Fix any failures before proceeding (no lint disables; split files if
`max-lines` trips).

- [ ] **Step 2: Confirm the no-op path against the real managed home (read-only)**

```bash
sqlite3 "file:$HOME/.local/share/orca/codex-runtime-home/home/state_5.sqlite?mode=ro" \
  "select status from backfill_state;"
```

Expected: `complete` (this machine's index finished on 2026-07-31). Also check the
**system home** leg the dual-home prewarm now covers (read-only):
`sqlite3 "file:$HOME/.codex/state_5.sqlite?mode=ro" "select status from backfill_state;" || true`.
This is the `already-complete` pre-warm path: with **both** homes reading `complete`,
launching the built app against real data must NOT spawn a codex child. Verify by launching
`pnpm dev`, waiting ~30s, and checking `pgrep -af 'codex.*app-server'` shows nothing spawned
by Orca; console shows no `[codex-state-db-prewarm] pre-warming` line. Quit the app.
If the real `~/.codex` state DB is NOT complete (or missing with a large history), the
system-home prewarm leg WILL spawn codex against it — that is exactly the shipped
production behavior (same class of action as the existing index-heal stage, which already
spawns codex with `CODEX_HOME: systemCodexHomePath`); record the observation instead of
treating it as a violation, and let it run to completion.

- [ ] **Step 3: Full repro E2E in a disposable user-data dir (the actual #11828 scenario)**

This reproduces the reporter's exact failure and proves both halves of the fix. It takes
tens of minutes of wall-clock time while the index runs; that is expected.

```bash
E2E_DATA=$(mktemp -d /tmp/orca-e2e-11828.XXXXXX)
mkdir -p "$E2E_DATA/codex-runtime-home/home"
# Why cp -a (real copies, NOT cp -al hardlinks): codex has a compression path that can
# replace rollout .jsonl files (openai/codex rollout/src/compression.rs — ledger A14);
# plain copies make it impossible for the E2E to touch ~/.codex originals. The 15 GB copy
# takes a few minutes and needs the disk space — that is the accepted cost of safety.
cp -a "$HOME/.codex/sessions" "$E2E_DATA/codex-runtime-home/home/sessions"
ORCA_USER_DATA_PATH="$E2E_DATA" pnpm dev
```

Observe and record (in the task's final report) each of:
1. Within ~60s of app start, the console logs
   `[codex-state-db-prewarm] pre-warming codex session index at ...` and
   `pgrep -af 'app-server'` shows a codex child with `CODEX_HOME` pointing into `$E2E_DATA`
   (check via `tr '\0' '\n' </proc/<pid>/environ | grep CODEX_HOME`).
   Note: the dual-home prewarm runs its **system-home leg first** (against the real
   `~/.codex`, expected `already-complete` and instant per Step 2) before the managed-home
   leg that targets the twin — the log line to watch for is the one whose path is inside
   `$E2E_DATA`. If a run is interrupted mid-index, expect codex starts against the twin to
   fail for up to 15 minutes (stale backfill lease, verified behavior) before resuming.
2. While it runs, open a Codex pane in the app: after ~30s the pane shows Codex's failure
   output AND the amber toast beginning "Codex is still indexing your session history…".
   A plain shell pane shows no toast.
3. Poll until done (many minutes):
   `sqlite3 "file:$E2E_DATA/codex-runtime-home/home/state_5.sqlite?mode=ro" "select status from backfill_state;"`
   flips to `complete`, the console logs `[codex-state-db-prewarm] codex session index complete`,
   and the codex child is gone (`pgrep -af 'app-server'` empty).
4. Open a new Codex pane: it starts normally (no damaged-database error, no toast).
5. Restart the app with the same `ORCA_USER_DATA_PATH`: no new prewarm spawn (step-2 no-op
   behavior on the now-complete twin home).

If observation 1 never happens, capture the `[codex-session-migration]` console lines and
the scheduler eligibility state and HALT with that evidence — do not fake the observations.

Cleanup:

```bash
rm -rf "$E2E_DATA"   # plain copies; ~/.codex originals are unaffected
```

- [ ] **Step 4: Commit any fixes from the verification**

If steps 1-3 forced code changes, re-run the relevant unit tests and gates, then commit with
messages scoped to what changed, e.g.:

```bash
git add -A
git commit -m "fix(codex): address prewarm e2e findings"
```

If nothing changed, skip the commit — do not create an empty one.

---

## Self-review record

- **Spec coverage:** (a) pre-warm the state DB for the homes panes actually use →
  Tasks 1-3 (dual-home: system home first — the home fresh real-home-lane panes read — then
  the managed home for resume-pinned panes; chained onto the same scheduler, re-run every app
  start and on host-default selection, resumable because it keys off `backfill_state` rather
  than a marker — also covers future `state_<N>` schema bumps via newest-file discovery);
  (b) surface the real story instead of the misleading error → Tasks 4-6; PR against `main`
  + repo conventions → Global Constraints; "don't make #11830 worse" → read-only DB access
  everywhere, no spawning against unreadable DBs, fast-failure-only respawn budget +
  deadline, stdin-EOF-first termination with Windows tree-kill; WSL2/repro machine
  specifics → Task 7.
- **No silent deferrals:** both user-facing outcomes are proven against production behavior
  in Task 7 (real 15 GB history — as safe copies, real codex binary, real panes); mocks exist
  only in unit tests. The headless `app-server` assumption set was verified against the real
  binary and openai/codex source during Stage-2 validation; Task 2 Step 1 remains as a cheap
  sanity re-run with its HALT rule intact.
- **Type consistency:** `CodexStateDbBackfillStatus` kinds (`complete | incomplete | missing |
  not-tracked | unreadable`) match between Tasks 1-2; `startCodexStateDbPrewarmInBackground`
  (now returning `CodexStateDbPrewarmSummary[] | null`) matches the scheduler's
  `MigrationRun` shape (`Promise<unknown>`) in Task 3; `CODEX_BACKFILL_INDEXING_NOTICE`
  first line ('Codex is still indexing your session history') is unchanged by the Stage-2
  text edit, so `isCodexBackfillIndexingNotice` in Task 5 and the tests in Task 6 still match.
- **Stage-2 load-bearing validation (2026-07-31):** 15 assumptions validated against live
  codex 0.146.0 runs, openai/codex `rust-v0.146.0` source, and this repo — 8 verified,
  6 falsified (A3 stale-lease behavior, A9 pane binary resolution, A10 home-lane targeting,
  A11 Windows/quit termination, A13 hidden-pane detection scope, A14 rollout-file
  immutability), 1 accepted (A12 silent background indexing; measured 10-13 min for 15 GB).
  All falsifications are planned around in this revision: dual-home prewarm, fast-exit-only
  respawn budget, lease-aware supervision, tree-kill/quit-stop termination, honest toast
  text, detection-scope note, `cp -a` E2E. Full evidence: `load-bearing-ledger.md` +
  `reports/` in the workflow logs dir (`.worktrees/.the-usual-logs/codex-backfill-prewarm/`).
