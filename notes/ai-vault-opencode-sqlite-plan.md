# Plan: AI Vault support for OpenCode SQLite storage

## Problem

OpenCode 1.17.x migrated session storage from per-session JSON files
(`~/.local/share/opencode/storage/session/<projectId>/<sessionId>.json` +
`storage/message/<sessionId>/*.json`) to a single SQLite database at
`~/.local/share/opencode/opencode.db`. The legacy file layout is no longer
written. The AI Vault session scanner (`src/main/ai-vault/session-scanner.ts`)
still only walks `storage/session/*.json`, so on any OpenCode 1.17.x install
the Agent Session History panel shows zero OpenCode sessions even though
hundreds exist in the DB.

A sibling scanner, `src/main/opencode-usage/scanner.ts`, already reads the
same SQLite DB for token/cost usage analytics. We reuse its patterns
(`SyncDatabase`, `listOpenCodeDatabases`, schema probes) so the AI Vault
scanner can read sessions from SQLite while keeping the legacy file path as a
fallback for older OpenCode installs.

## Goals

1. OpenCode sessions stored in `opencode.db` appear in Agent Session History.
2. Legacy file-based OpenCode installs (pre-1.17) keep working.
3. No new third-party dependencies — reuse the existing `SyncDatabase`
   adapter backed by Node's built-in `node:sqlite`.
4. Resume commands, previews, tokens, cwd, and model fields are populated
   from SQLite exactly as they were from the JSON files.
5. Tests cover both the SQLite path and the legacy file fallback.

## Non-goals

- Writing to the OpenCode DB (read-only).
- Migrating or deleting legacy file storage.
- Changing the AI Vault UI, IPC contract, or cache layer.
- Backfilling `opencode-stable.db` (separate OpenCode bug, not ours).

## Architecture

```
scanAiVaultSessions()
  ├── discoverFiles(... per-agent file scanners ...)   ← unchanged
  │     └── opencode: discoverFiles(storage/session)    ← kept as fallback
  └── NEW: discoverOpenCodeSqliteSessions(dbPaths)      ← SQLite path
        └── parseOpenCodeSqliteSession(db, sessionId)   ← builds AiVaultSession
```

The SQLite discovery returns `SessionFileCandidate`-shaped rows so it slots
into the existing `candidates` array and reuses `parseSessionCandidates` /
`canStopParsingSessions` / sort+slice. We synthesize a `FileWithMtime` per
row (path = `<dbPath>#<sessionId>`, mtimeMs = `session.time_updated`) so the
existing sort-by-mtime logic works unchanged.

## OpenCode SQLite schema (verified on 1.17.8)

```sql
session:
  id, project_id, parent_id, slug, directory, title, version,
  time_created (ms int), time_updated (ms int), time_archived,
  model (JSON: {"id","providerID","variant"}),
  agent, cost, tokens_input, tokens_output, tokens_reasoning,
  tokens_cache_read, tokens_cache_write, metadata

message:
  id, session_id, time_created, time_updated, data (JSON)
  data.role        ∈ {user, assistant, system, tool}
  data.path.cwd    string   (assistant messages carry cwd)
  data.path.root   string
  data.agent       string   (e.g. "build")
  data.model       {modelID, providerID}
  data.summary     {title, body, diffs}  (user messages)

part:
  id, message_id, session_id, time_created, time_updated, data (JSON)
  data.type ∈ {text, tool, reasoning, …}
  data.text string          (text + reasoning parts)
  data.time {start, end}    (ms int)

project:
  id, worktree, name, vcs
```

## Implementation steps

### 1. New module: `src/main/ai-vault/session-scanner-opencode-sqlite.ts`

Pure functions, no Electron imports, fully unit-testable.

```ts
export type OpenCodeSqliteSessionRow = {
  id: string
  title: string
  directory: string
  timeCreatedMs: number
  timeUpdatedMs: number
  modelJson: string | null
  agent: string | null
  tokensInput: number
  tokensOutput: number
  tokensReasoning: number
  tokensCacheRead: number
  cost: number
  messageCount: number
}

export async function listOpenCodeSqliteSessions(args: {
  dbPaths: readonly string[]
  limit: number
  issues: AiVaultScanIssue[]
}): Promise<SessionFileCandidate[]>

export async function parseOpenCodeSqliteSession(args: {
  dbPath: string
  sessionId: string
  platform: NodeJS.Platform
}): Promise<AiVaultSession | null>
```

Responsibilities:

- Open each DB via `SyncDatabase` from `../sqlite/sync-database` with
  `{ readonly: true, fileMustExist: true }` and `pragma('query_only = ON')`
  (same as `opencode-usage/scanner.ts`).
- Probe schema with the existing `tableExists` / `columnExists` helpers
  (extract them to `session-scanner-values.ts` or a new
  `session-scanner-sqlite-helpers.ts` — see step 2).
- If `session` table missing → return `[]` (legacy install, file scanner
  handles it).
- Query top-N sessions ordered by `time_updated DESC`:

  ```sql
  SELECT s.id, s.title, s.directory, s.time_created, s.time_updated,
         s.model AS model_json, s.agent,
         s.tokens_input, s.tokens_output, s.tokens_reasoning,
         s.tokens_cache_read, s.cost,
         (SELECT COUNT(*) FROM message m
            WHERE m.session_id = s.id
              AND json_extract(m.data, '$.role') IN ('user','assistant'))
           AS message_count
  FROM session s
  WHERE s.time_archived IS NULL
  ORDER BY s.time_updated DESC
  LIMIT :limit
  ```

- Skip child sessions (`parent_id IS NOT NULL`) so oh-my-opencode spawned
  sub-sessions don't flood the vault. Add a `WHERE s.parent_id IS NULL`
  predicate (matches the `isChildSession` logic in the hook plugin).
- Synthesize `FileWithMtime`:
  - `path` = `${dbPath}#${sessionId}` (stable, unique, debuggable)
  - `mtimeMs` = `timeUpdatedMs`
  - `modifiedAt` = `new Date(timeUpdatedMs).toISOString()`
- Return `SessionFileCandidate[]` with `agent: 'opencode'`, `codexHome: null`.

`parseOpenCodeSqliteSession`:

- Reopen the DB readonly, fetch the single session row.
- Build a `SessionAccumulator` via `createAccumulator` (reuse from
  `session-scanner-accumulator.ts`) using the synthesized `FileWithMtime`.
- Populate accumulator fields directly from the session row:
  - `title` ← `session.title` (via `normalizeTitleText`)
  - `cwd` ← `session.directory`
  - `model` ← `json_extract(session.model, '$.id')` (fall back to
    `$.modelID` for older schemas)
  - `totalTokens` ← `tokens_input + tokens_output + tokens_reasoning`
  - `messageCount` ← the subquery count
  - `createdAt`/`updatedAt` ← `updateTimeline(acc, timeCreatedMs)` +
    `updateTimeline(acc, timeUpdatedMs)`
- Fetch up to 5 preview messages (newest first) by joining `message` →
  `part`:

  ```sql
  SELECT m.id AS message_id, json_extract(m.data, '$.role') AS role,
         p.id AS part_id, p.data AS part_data, p.time_created
  FROM message m
  JOIN part p ON p.message_id = m.id
  WHERE m.session_id = ?
    AND json_extract(m.data, '$.role') IN ('user','assistant')
    AND json_extract(p.data, '$.type') = 'text'
  ORDER BY p.time_created DESC
  LIMIT 5
  ```

  Reverse the result before pushing so the accumulator's
  `SESSION_PREVIEW_MESSAGE_LIMIT` shift keeps the newest 5. Use
  `addPreviewMessage(acc, { role, text: json_extract(part_data, '$.text'),
  timestamp: part.time_created })`. Map `role` to the union type
  (`'user' | 'assistant' | 'unknown'`).
- For the first user message, also try `json_extract(m.data, '$.summary.title')`
  / `$.summary.body` as a title fallback (matches the legacy parser).
- Call `finalizeSession(acc, platform)` to get the `AiVaultSession` with
  `resumeCommand = "cd <cwd> && opencode --session '<id>'"` (already handled
  by `buildAiVaultResumeCommand` for `agent: 'opencode'`).

### 2. Extract shared SQLite helpers

`opencode-usage/scanner.ts` has private `tableExists` / `columnExists` /
`getProjectJoin` / `getSessionModelSelect`. To avoid duplication, move the
generic ones (`tableExists`, `columnExists`) into a new
`src/main/sqlite/schema-helpers.ts` and import from both scanners.
`getProjectJoin` / `getSessionModelSelect` are usage-specific; leave them
where they are.

### 3. Wire SQLite discovery into `scanAiVaultSessions`

In `src/main/ai-vault/session-scanner.ts`:

- Import `listOpenCodeDatabases` from `../opencode-usage/scanner` (already
  exported) and `listOpenCodeSqliteSessions` from the new module.
- Replace the single `discoverFiles({ rootDir: join(opencodeStorage, 'session'), … })`
  call with:

  ```ts
  const opencodeDbPaths = await listOpenCodeDatabases()
  const opencodeSqliteDiscovery = await listOpenCodeSqliteSessions({
    dbPaths: opencodeDbPaths,
    limit: limitPerAgent,
    issues
  })
  const opencodeFileDiscovery = await discoverFiles({
    rootDir: join(options.opencodeStorageDir ?? OPENCODE_STORAGE_DIR, 'session'),
    limit: limitPerAgent,
    agent: 'opencode',
    issues,
    extensions: ['.json']
  })
  ```

  Push both into the `discoveries` array. The existing
  `flatMap` + sort-by-mtime + `parseSessionCandidates` pipeline handles the
  rest. `parseAgentSessionFile` already dispatches `case 'opencode'` to
  `parseOpenCodeSessionFile`; we add a branch that detects the
  `<dbPath>#<sessionId>` synthetic path and routes to
  `parseOpenCodeSqliteSession` instead.

- Add `opencodeDbPaths?: readonly string[]` to `AiVaultScanOptions` so tests
  can inject a temp DB without touching `listOpenCodeDatabases`.

### 4. Route synthetic paths in the parser dispatcher

In `session-scanner-agent-parser.ts`:

```ts
case 'opencode':
  if (candidate.file.path.includes('#') && looksLikeOpenCodeDbPath(candidate.file.path)) {
    const { dbPath, sessionId } = splitOpenCodeSqliteCandidate(candidate.file.path)
    return parseOpenCodeSqliteSession({ dbPath, sessionId, platform })
  }
  return parseOpenCodeSessionFile(candidate.file, platform)
```

`looksLikeOpenCodeDbPath` / `splitOpenCodeSqliteCandidate` live in the new
sqlite module and are exported for the dispatcher. Keep the `#` separator
out of any real filesystem path (it's illegal in Windows filenames and
unused in opencode session ids) so there's no ambiguity.

### 5. IPC wiring

`src/main/ipc/ai-vault.ts` already calls `scanAiVaultSessions({ limit,
additionalCodexSessionsDirs })`. No change needed — the new SQLite
discovery runs inside `scanAiVaultSessions`. The 15s cache and `force`
bypass continue to work as-is.

### 6. Tests

New file: `src/main/ai-vault/session-scanner-opencode-sqlite.test.ts`

- Build an in-memory or temp-file SQLite DB with the schema above (use
  `SyncDatabase` against `:memory:` or a tmpdir file).
- Insert 3 sessions (1 archived, 1 child, 1 normal) + messages + parts.
- Assert `listOpenCodeSqliteSessions` returns only the normal parent
  session, with correct synthesized `FileWithMtime`.
- Assert `parseOpenCodeSqliteSession` returns an `AiVaultSession` with:
  - correct `sessionId`, `title`, `cwd`, `model`, `totalTokens`
  - `messageCount` = 2 (one user + one assistant)
  - `previewMessages` has the 2 text parts, newest-last ordering
  - `resumeCommand` matches `cd '/tmp/x' && opencode --session 'ses_…'`
- Assert archived and child sessions are excluded.

Extend `session-scanner.test.ts`:

- Add a test that creates a temp `opencode.db` with one session and asserts
  it appears in `scanAiVaultSessions` output alongside a legacy
  `storage/session/.../ses_old.json` session (proves both paths coexist).
- Pass `opencodeDbPaths: [tmpDb]` via the new option so the test doesn't
  depend on the real `~/.local/share/opencode`.

### 7. Edge cases & compatibility

- **Older OpenCode without the `session` table**: `tableExists` returns
  false → SQLite discovery returns `[]` → file scanner handles it.
- **Mixed install** (some sessions in files, some in DB): both discoveries
  run; dedup by `sessionId` in `parseSessionCandidates` is not needed
  because the synthetic `<db>#<id>` path differs from the file path and
  produces a different `AiVaultSession.id` — but the UI groups by cwd, so
  duplicates would show twice. Add a `Set<string>` of seen sessionIds in
  `scanAiVaultSessions` after parsing, and drop file-based entries when a
  SQLite entry with the same sessionId already exists (SQLite is the
  source of truth on 1.17.x).
- **WAL mode**: `SyncDatabase` opens readonly; WAL files are read
  transparently. No checkpoint needed.
- **`opencode-stable.db`**: `listOpenCodeDatabases` already matches
  `opencode*.db`, so stable snapshots are scanned too. If a session exists
  in both `opencode.db` and `opencode-stable.db`, dedup by sessionId keeps
  the one with the newer `time_updated`.
- **Windows**: `#` is not legal in NTFS filenames, so the synthetic path
  is unambiguous. `SyncDatabase` and `node:sqlite` are cross-platform.
- **Large DBs** (your install: 1.4 GB, 1677 sessions): the `LIMIT :limit`
  + `ORDER BY time_updated DESC` + `time_archived IS NULL` predicate keeps
  the query cheap. Index `session_parent_idx` and `session_project_idx`
  already exist; no new index needed for the preview-messages join since
  `part_message_id_id_idx` covers it.

### 8. Files touched

| File | Change |
| --- | --- |
| `src/main/ai-vault/session-scanner-opencode-sqlite.ts` | **new** — discovery + parser |
| `src/main/ai-vault/session-scanner-opencode-sqlite.test.ts` | **new** — unit tests |
| `src/main/sqlite/schema-helpers.ts` | **new** — `tableExists`, `columnExists` |
| `src/main/ai-vault/session-scanner.ts` | call SQLite discovery alongside file discovery; dedup by sessionId |
| `src/main/ai-vault/session-scanner-types.ts` | add `opencodeDbPaths?: readonly string[]` to `AiVaultScanOptions` |
| `src/main/ai-vault/session-scanner-agent-parser.ts` | route synthetic `db#id` paths to the SQLite parser |
| `src/main/opencode-usage/scanner.ts` | import `tableExists`/`columnExists` from the new helpers module (no behavior change) |
| `src/main/ai-vault/session-scanner.test.ts` | add a mixed SQLite + file scenario |

No renderer, preload, shared-types, or IPC-protocol changes — the
`AiVaultSession` shape is unchanged.

### 9. Verification

- `pnpm install` (no new deps).
- `pnpm run typecheck`
- `pnpm run lint`
- `pnpm exec vitest run --config config/vitest.config.ts \
    src/main/ai-vault/session-scanner-opencode-sqlite.test.ts \
    src/main/ai-vault/session-scanner.test.ts`
- Manual: launch dev Orca against the real `~/.local/share/opencode/opencode.db`,
  open the right-sidebar Agent Session History, confirm OpenCode sessions
  appear with correct titles, cwd, model, token totals, and that "Resume"
  produces `cd <cwd> && opencode --session '<id>'` and launches a working
  terminal.

### 10. Rollout

Single PR, no feature flag. The SQLite path is additive and self-disabling
on legacy installs. Ship in the next patch release after v1.4.88.
