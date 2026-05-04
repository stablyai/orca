# Fix: Claude & Codex accounts intermittently return 401 Unauthorized

**Issue:** [#1284](https://github.com/stablyai/orca/issues/1284)
**Status:** Proposed fix
**Approach:** Add `readBackRefreshedTokens()` to both `CodexRuntimeHomeService` and `ClaudeRuntimeAuthService`

## Problem

Codex (and Claude) managed accounts intermittently return `401 Unauthorized` / `token_expired` errors after working normally for some time.

### Root Cause

Both `CodexRuntimeHomeService` and `ClaudeRuntimeAuthService` perform a **one-directional** auth sync: they always copy the managed account's credentials into the shared runtime path, but never read back refreshed tokens.

**The problematic flow (identical for both providers):**

1. User authenticates → credentials saved to managed storage
2. `syncForCurrentSelection()` copies managed credentials → runtime path
3. CLI runs using the runtime credentials
4. OAuth access token expires over time. **CLI refreshes it and writes updated tokens back to the runtime path**
5. Next PTY launch or rate-limit fetch triggers `syncForCurrentSelection()` again
6. **The sync overwrites the runtime credentials with the stale managed copy** — the refreshed token is lost
7. Next request uses the expired token → `401 Unauthorized`

**Codex specifics:**
- Runtime path: `~/.codex/auth.json`
- Managed path: `<userData>/codex-accounts/<id>/home/auth.json`
- Affected: `CodexRuntimeHomeService.syncForCurrentSelection()` line 84

**Claude specifics:**
- Runtime path: `~/.claude/.credentials.json` (+ Keychain on macOS)
- Managed path: `<userData>/claude-accounts/<id>/auth/.credentials.json` (+ Keychain)
- Affected: `ClaudeRuntimeAuthService.doSyncForCurrentSelection()` line 125
- Note: Claude already has `lastWrittenCredentialsJson` and `detectExternalLoginAndUpdateSnapshot()` for the managed→system-default transition, but it **does not** read back refreshed tokens during steady-state sync — the same one-directional overwrite happens

### Why it's intermittent

- Tokens have a multi-hour lifetime, so the bug only surfaces after enough time passes for the original token to expire
- The overwrite only happens on PTY launch or rate-limit fetch, not continuously
- If the user re-authenticates, the cycle resets with a fresh token

### Affected code

**Codex:**
- `src/main/codex-accounts/runtime-home-service.ts` — `syncForCurrentSelection()` (line 49-85)
- Called from `prepareForCodexLaunch()` (line 39) and `prepareForRateLimitFetch()` (line 44)

**Claude:**
- `src/main/claude-accounts/runtime-auth-service.ts` — `doSyncForCurrentSelection()` (line 96-131)
- Called from `prepareForClaudeLaunch()` (line 47) and `prepareForRateLimitFetch()` (line 52)

## System Context

```
┌──────────────────────────────────────────────────────────────┐
│                         Orca (main process)                  │
│                                                              │
│  ┌──────────────────────────────────────────────────┐        │
│  │          CodexRuntimeHomeService                  │        │
│  │                                                   │        │
│  │  lastSyncedAccountId: string | null               │        │
│  │  lastWrittenAuthJson: string | null  ← NEW        │        │
│  │                                                   │        │
│  │  syncForCurrentSelection()                        │        │
│  │    ├─ captureSystemDefaultSnapshotIfNeeded()       │        │
│  │    ├─ readBackRefreshedTokens()          ← NEW    │        │
│  │    └─ writeRuntimeAuth()                          │        │
│  │                                                   │        │
│  │  restoreSystemDefaultSnapshot()                   │        │
│  │    └─ detectExternalLoginAndUpdateSnapshot() ← NEW│        │
│  └──────────┬──────────────────────────┬─────────────┘        │
│             │                          │                      │
│     ┌───────▼───────┐         ┌────────▼──────────┐          │
│     │ Managed Home  │         │  Runtime Home     │          │
│     │ <userData>/   │         │  ~/.codex/        │          │
│     │ codex-accounts│         │  auth.json        │          │
│     │ /<id>/home/   │         │                   │          │
│     │ auth.json     │         │                   │          │
│     └───────────────┘         └────────┬──────────┘          │
└──────────────────────────────────────────┼────────────────────┘
                                           │
                                   ┌───────▼───────┐
                                   │   Codex CLI   │
                                   │               │
                                   │ reads auth.json
                                   │ refreshes token
                                   │ writes back   │
                                   └───────────────┘
```

## Data Flow: Token Refresh Preservation

```
  PTY launch / rate-limit fetch
           │
           ▼
  syncForCurrentSelection()
           │
           ├─ captureSystemDefaultSnapshotIfNeeded()
           │
           ├─ Is lastSyncedAccountId === activeAccount.id?
           │      │
           │    YES → readBackRefreshedTokens()
           │      │     │
           │      │     ├─ Read ~/.codex/auth.json (current runtime)
           │      │     ├─ Compare to lastWrittenAuthJson
           │      │     │     │
           │      │     │   DIFFER → Codex CLI refreshed the token
           │      │     │     │       Write runtime auth.json back
           │      │     │     │       to managed home auth.json
           │      │     │     │
           │      │     │   MATCH  → No external changes, continue
           │      │     │
           │      │     └─ (try/catch: failures log + continue)
           │      │
           │    NO  → Skip read-back (account switch in progress)
           │
           ├─ Read managed auth.json
           ├─ writeRuntimeAuth(contents)
           │     ├─ Write to ~/.codex/auth.json
           │     └─ Record lastWrittenAuthJson = contents
           │
           └─ lastSyncedAccountId = activeAccount.id
```

## Data Flow: External Login Detection (managed → system-default)

```
  User deselects managed account (activeAccount = null)
           │
           ▼
  syncForCurrentSelection()
           │
           ├─ lastSyncedAccountId !== null? (was managed)
           │      │
           │    YES → restoreSystemDefaultSnapshot()
           │      │     │
           │      │     ├─ detectExternalLoginAndUpdateSnapshot()
           │      │     │     │
           │      │     │     ├─ lastWrittenAuthJson !== null?
           │      │     │     ├─ Read current ~/.codex/auth.json
           │      │     │     ├─ Compare to lastWrittenAuthJson
           │      │     │     │     │
           │      │     │     │   DIFFER → External login detected
           │      │     │     │     │       (e.g. `codex auth login`)
           │      │     │     │     │       Delete stale snapshot
           │      │     │     │     │       Clear lastWrittenAuthJson
           │      │     │     │     │       Return true (skip restore)
           │      │     │     │     │
           │      │     │     │   MATCH  → No external login
           │      │     │     │           Return false (do restore)
           │      │     │     │
           │      │     │     └─ (try/catch: failures → return false)
           │      │     │
           │      │     └─ If not external: restore snapshot as before
           │      │
           │    NO  → Skip (was never managed)
           │
           └─ lastSyncedAccountId = null
```

## Fix: Add `readBackRefreshedTokens()` to Both Services

The fix adds the same read-back mechanism to both `CodexRuntimeHomeService` and `ClaudeRuntimeAuthService`. The core logic is identical: before overwriting runtime credentials, compare the file to what Orca last wrote. If they differ, the CLI refreshed the token — write it back to managed storage.

### What each service needs

| Change | Codex (`runtime-home-service.ts`) | Claude (`runtime-auth-service.ts`) |
|--------|-----------------------------------|-------------------------------------|
| Add `lastWrittenAuthJson` field | **NEW** | Already exists as `lastWrittenCredentialsJson` |
| Track writes in `writeRuntime*()` | **NEW** | Already done (line 271) |
| `readBackRefreshedTokens()` | **NEW** | **NEW** (missing despite having the tracking field) |
| `detectExternalLoginAndUpdateSnapshot()` | **NEW** | Already exists (line 224) |
| `clearLastWritten*()` for re-auth | **NEW** | **NEW** (same re-auth clobbering risk) |

### Key differences between services

| Aspect | Claude | Codex |
|--------|--------|-------|
| Auth storage | Keychain (macOS) + `.credentials.json` | `auth.json` only |
| Sync model | Async (serialized via `mutationQueue`) | Synchronous |
| Managed path | `managedAuthPath/.credentials.json` | `managedHomePath/auth.json` |
| Tracking field | `lastWrittenCredentialsJson` | `lastWrittenAuthJson` |

### Codex implementation

Add a `lastWrittenAuthJson` field and three new behaviors:

1. **`writeRuntimeAuth()`** — record what was written
2. **`readBackRefreshedTokens()`** — before overwriting, check if Codex CLI refreshed the token
3. **`detectExternalLoginAndUpdateSnapshot()`** — on managed→system-default transition, detect external logins

### Pseudocode

```typescript
export class CodexRuntimeHomeService {
  private lastSyncedAccountId: string | null = null

  // Why: tracks the auth.json content Orca last wrote to ~/.codex/auth.json.
  // On managed→system-default transition, if the file differs from this value,
  // an external login (e.g. `codex auth login`) overwrote it — so Orca adopts
  // the file as the new system default instead of restoring a stale snapshot.
  // Between syncs, if the file differs, Codex CLI refreshed the token — so
  // Orca writes back the refreshed token to managed storage.
  private lastWrittenAuthJson: string | null = null

  // ... constructor, prepare methods unchanged ...

  syncForCurrentSelection(): void {
    this.captureSystemDefaultSnapshotIfNeeded()

    const settings = this.store.getSettings()
    const activeAccount = this.getActiveAccount(
      settings.codexManagedAccounts,
      settings.activeCodexManagedAccountId
    )
    if (!activeAccount) {
      if (this.lastSyncedAccountId !== null) {
        this.restoreSystemDefaultSnapshot()
        this.lastSyncedAccountId = null
      }
      return
    }

    const activeAuthPath = join(activeAccount.managedHomePath, 'auth.json')
    if (!existsSync(activeAuthPath)) {
      console.warn(
        '[codex-runtime-home] Active managed account is missing auth.json, restoring system default'
      )
      this.store.updateSettings({ activeCodexManagedAccountId: null })
      if (this.lastSyncedAccountId !== null) {
        this.restoreSystemDefaultSnapshot()
        this.lastSyncedAccountId = null
      }
      return
    }

    // NEW: Before overwriting runtime auth, check if Codex CLI refreshed
    // the token since our last write. If so, preserve those refreshed tokens
    // back to managed storage so they aren't lost.
    if (this.lastSyncedAccountId === activeAccount.id) {
      this.readBackRefreshedTokens(activeAuthPath)
    }

    this.lastSyncedAccountId = activeAccount.id
    this.writeRuntimeAuth(readFileSync(activeAuthPath, 'utf-8'))
  }

  // Why: Codex CLI refreshes expired OAuth tokens and writes them back to
  // ~/.codex/auth.json. If we detect the runtime file differs from what Orca
  // last wrote, the CLI must have refreshed — so we write the updated tokens
  // back to managed storage before overwriting runtime with managed state.
  // This is the Codex analog of the read-back logic implied by
  // lastWrittenCredentialsJson in ClaudeRuntimeAuthService.
  private readBackRefreshedTokens(managedAuthPath: string): void {
    try {
      const runtimeAuthPath = this.getRuntimeAuthPath()
      if (!existsSync(runtimeAuthPath)) {
        return
      }

      // Nothing to compare against — first sync or after restart.
      // Skip read-back to avoid capturing stale/unknown state.
      if (this.lastWrittenAuthJson === null) {
        return
      }

      const runtimeContents = readFileSync(runtimeAuthPath, 'utf-8')
      if (runtimeContents === this.lastWrittenAuthJson) {
        return
      }

      // Codex CLI refreshed tokens at runtime — preserve them in managed storage.
      writeFileAtomically(managedAuthPath, runtimeContents, { mode: 0o600 })
    } catch (error) {
      // Why: read-back is best-effort. A transient fs error (permissions,
      // file locked by another process) must not block the forward sync
      // path — the worst case is one more stale-token cycle, which is
      // strictly better than failing the entire sync.
      console.warn('[codex-runtime-home] Failed to read back refreshed tokens:', error)
    }
  }

  private restoreSystemDefaultSnapshot(): void {
    // Why: detect whether an external tool (e.g. `codex auth login`) overwrote
    // auth.json while a managed account was active. If so, that external login
    // becomes the new system default — skip the stale snapshot restore.
    if (this.detectExternalLoginAndUpdateSnapshot()) {
      return
    }

    const snapshotPath = this.getSystemDefaultSnapshotPath()
    if (!existsSync(snapshotPath)) {
      return
    }

    this.writeRuntimeAuth(readFileSync(snapshotPath, 'utf-8'))
  }

  // Why: mirrors ClaudeRuntimeAuthService.detectExternalLoginAndUpdateSnapshot().
  // If the runtime auth.json differs from what Orca last wrote, something
  // external changed it. That external state should become the new system
  // default rather than being overwritten by a potentially stale snapshot.
  private detectExternalLoginAndUpdateSnapshot(): boolean {
    if (this.lastWrittenAuthJson === null) {
      return false
    }

    const runtimeAuthPath = this.getRuntimeAuthPath()
    if (!existsSync(runtimeAuthPath)) {
      return false
    }

    try {
      const currentAuth = readFileSync(runtimeAuthPath, 'utf-8')
      if (currentAuth === this.lastWrittenAuthJson) {
        return false
      }
    } catch {
      return false
    }

    // External login detected — adopt current state as the new system default.
    const snapshotPath = this.getSystemDefaultSnapshotPath()
    rmSync(snapshotPath, { force: true })
    this.lastWrittenAuthJson = null
    return true
  }

  private writeRuntimeAuth(contents: string): void {
    writeFileAtomically(this.getRuntimeAuthPath(), contents, { mode: 0o600 })
    // Why: record what we wrote so readBackRefreshedTokens() and
    // detectExternalLoginAndUpdateSnapshot() can detect external changes.
    this.lastWrittenAuthJson = contents
  }
}
```

### Re-auth safety: clearing `lastWrittenAuthJson`

When `CodexAccountService.doReauthenticateAccount()` runs, it writes fresh tokens to managed storage via `codex login`, then calls `syncForCurrentSelection()`. Without intervention, the read-back logic would see that runtime differs from `lastWrittenAuthJson` (because Codex CLI may have refreshed the runtime token between syncs) and write the stale runtime content back to managed — overwriting the fresh re-auth tokens.

**Fix:** `CodexRuntimeHomeService` must expose a method to clear `lastWrittenAuthJson` so that the re-auth caller can signal "managed storage was externally updated, skip read-back on next sync."

```typescript
// Called by CodexAccountService before syncForCurrentSelection() after re-auth or add-account.
clearLastWrittenAuthJson(): void {
  this.lastWrittenAuthJson = null
}
```

The same applies to `doAddAccount()`, which also writes managed auth then syncs. Both callers must call `clearLastWrittenAuthJson()` before `syncForCurrentSelection()`.

### Changes to `CodexAccountService`

Both `doAddAccount()` and `doReauthenticateAccount()` write fresh tokens to managed storage (via `codex login`) then call `syncForCurrentSelection()`. They must clear the tracking field first to prevent read-back from overwriting the fresh tokens:

```typescript
// In doAddAccount(), after runCodexLogin succeeds:
this.runtimeHome.clearLastWrittenAuthJson()
this.runtimeHome.syncForCurrentSelection()

// In doReauthenticateAccount(), after runCodexLogin succeeds:
this.runtimeHome.clearLastWrittenAuthJson()
this.runtimeHome.syncForCurrentSelection()
```

### Safety considerations

- **Only reads back when Orca owns the runtime auth** (`lastSyncedAccountId === activeAccount.id`), so external `codex login` changes are not accidentally captured into the wrong managed account
- **Skips read-back when `lastWrittenAuthJson` is null** (first sync, after restart, or after re-auth/add) — avoids capturing stale or unknown state that Orca didn't write
- **try/catch around read-back** — a transient fs error (permissions, locked file) logs a warning but does not block the forward sync. Worst case: one more stale-token cycle, strictly better than a sync failure
- **try/catch around external login detection** — same rationale; detection failure falls through to normal snapshot restore, which is the safe default
- **Atomic write** to managed auth prevents partial-write corruption
- **No behavior change for account switches** — when switching accounts, `lastSyncedAccountId` differs from the new account ID, so no read-back occurs
- **No behavior change for system-default flow** — read-back only runs when a managed account is active and was previously synced
- **External login detection on managed→system-default transition** — if `codex auth login` ran while a managed account was active, the snapshot is stale. Deleting it and clearing `lastWrittenAuthJson` lets the external login persist as the new system default
- **In-memory tracking only** — `lastWrittenAuthJson` is not persisted to disk. After an Orca restart, the field is null, and the first sync performs a clean write without read-back. This is intentionally conservative: we'd rather do one redundant overwrite than risk reading back unknown state

### Claude implementation

Claude already has `lastWrittenCredentialsJson` tracking and `detectExternalLoginAndUpdateSnapshot()`. It only needs two additions:

1. **`readBackRefreshedTokens()`** — same logic as Codex, adapted for Claude's async model and Keychain
2. **`clearLastWrittenCredentialsJson()`** — for re-auth safety (same pattern as Codex)

```typescript
// In ClaudeRuntimeAuthService:

// Add to doSyncForCurrentSelection(), before writeRuntimeCredentials():
if (this.lastSyncedAccountId === activeAccount.id) {
  await this.readBackRefreshedTokens(activeAccount)
}

// Why: Claude CLI refreshes expired OAuth tokens and writes them back to
// .credentials.json (and Keychain on macOS). If we detect the runtime file
// differs from what Orca last wrote, the CLI must have refreshed.
private async readBackRefreshedTokens(account: ClaudeManagedAccount): Promise<void> {
  try {
    if (this.lastWrittenCredentialsJson === null) {
      return
    }

    const paths = this.pathResolver.getRuntimePaths()
    if (!existsSync(paths.credentialsPath)) {
      return
    }

    const runtimeContents = readFileSync(paths.credentialsPath, 'utf-8')
    if (runtimeContents === this.lastWrittenCredentialsJson) {
      return
    }

    // CLI refreshed tokens — write back to managed storage.
    if (process.platform === 'darwin') {
      await writeManagedClaudeKeychainCredentials(account.id, runtimeContents)
    } else {
      const credentialsPath = join(account.managedAuthPath, '.credentials.json')
      writeFileAtomically(credentialsPath, runtimeContents, { mode: 0o600 })
    }
  } catch (error) {
    console.warn('[claude-runtime-auth] Failed to read back refreshed tokens:', error)
  }
}

// Exposed for ClaudeAccountService to call before sync after re-auth/add.
clearLastWrittenCredentialsJson(): void {
  this.lastWrittenCredentialsJson = null
}
```

### Changes to `ClaudeAccountService`

Same pattern as Codex — both `doAddAccount()` and `doReauthenticateAccount()` must clear the tracking field before syncing:

```typescript
// In doAddAccount(), after login succeeds:
this.runtimeAuth.clearLastWrittenCredentialsJson()
await this.runtimeAuth.syncForCurrentSelection()

// In doReauthenticateAccount(), after login succeeds:
this.runtimeAuth.clearLastWrittenCredentialsJson()
await this.runtimeAuth.syncForCurrentSelection()
```

### Structural alignment

The two services should stay structurally aligned. Both now have the same three mechanisms:

| Mechanism | Codex | Claude |
|-----------|-------|--------|
| Track what we wrote | `lastWrittenAuthJson` | `lastWrittenCredentialsJson` |
| Read back refreshed tokens | `readBackRefreshedTokens()` | `readBackRefreshedTokens()` |
| Detect external logins | `detectExternalLoginAndUpdateSnapshot()` | `detectExternalLoginAndUpdateSnapshot()` |
| Clear tracking on re-auth | `clearLastWrittenAuthJson()` | `clearLastWrittenCredentialsJson()` |

Future changes to either service should be cross-checked against the other.

### Files to modify

**Codex:**
- `src/main/codex-accounts/runtime-home-service.ts` — add `lastWrittenAuthJson` field, `readBackRefreshedTokens()`, `detectExternalLoginAndUpdateSnapshot()`, `clearLastWrittenAuthJson()`, update `writeRuntimeAuth()` and `restoreSystemDefaultSnapshot()`
- `src/main/codex-accounts/service.ts` — add `clearLastWrittenAuthJson()` calls in `doAddAccount()` and `doReauthenticateAccount()`
- `src/main/codex-accounts/runtime-home-service.test.ts` — add test cases

**Claude:**
- `src/main/claude-accounts/runtime-auth-service.ts` — add `readBackRefreshedTokens()`, `clearLastWrittenCredentialsJson()`, call read-back in `doSyncForCurrentSelection()`
- `src/main/claude-accounts/service.ts` — add `clearLastWrittenCredentialsJson()` calls in `doAddAccount()` and `doReauthenticateAccount()`
- `src/main/claude-accounts/runtime-auth-service.test.ts` — add test cases

**Test cases (both services):**
- Token read-back when CLI refreshes tokens between syncs
- No read-back on first sync (tracking field is null)
- No read-back on account switch (`lastSyncedAccountId` differs)
- External login detection on managed→system-default transition
- Graceful degradation when read-back throws (fs error)
- Re-auth does not lose fresh tokens: after clearing tracking field + sync, managed storage retains the re-auth tokens
- Add-account does not lose fresh tokens: same pattern as re-auth
