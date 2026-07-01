---
phase: 2
title: "Connection Model and Secure Persistence"
status: done
effort: "M"
---

# Phase 2: Connection Model and Secure Persistence

<!-- Updated: Validation Session 1 - weak-backend=warn+store; SSL default=smart-by-host; readOnly default=writable(false) -->

## Overview

Define the connection data model (incl. the `readOnly` flag, default **writable**),
persist a global connection list with the password **encrypted with a real OS
backend when available**, and build the connection-management UI. On a weak/absent
crypto backend the app **warns and still stores** (validated decision) so headless/SSH
developers keep working. No live DB driver yet — that's Phase 3.

## Requirements

- Functional: create/read/update/delete connections; list renders; form validates
  per engine; password never shown after save; `readOnly` defaults **false** (writable);
  SSL defaults **smart-by-host**.
- Non-functional: password encrypted via a strong `safeStorage` backend; when only the
  weak `basic_text` backend (or none) is available, show a clear banner and store with
  informed consent (warn-and-store) — never a *silent* weak write. List is global.

## Architecture

Mirror the SSH-target list/CRUD pattern, but **do not** reuse the cookie-grade crypto
path for DB passwords (red-team F2/F5/F-decrypt). Connections live in the global JSON
`Store` (`persistence.ts`) as `dbConnections[]`, normalized on load, saved via
`scheduleSave()`.

**Credential security deltas:**
- `encrypt()` (`persistence.ts:213-218`) silently returns plaintext when
  `!isEncryptionAvailable()`, and `isEncryptionAvailable()` returns **true** even for
  the hardcoded-key `basic_text` backend. For DB passwords, check
  `safeStorage.getSelectedStorageBackend()`: strong backend → encrypt; weak
  (`basic_text`) or unavailable → **warn-and-store** behind a clear UI banner
  (validated). Never silently persist a recoverable secret without the banner.
- Decrypt must be **fail-closed**: the shared `decrypt()` (`:225-239`) returns the
  ciphertext on failure (fine for a cookie, wrong for a credential). Use a strict DB
  variant that throws → surfaced as "password could not be decrypted on this machine".
- The connection list lives in `orca-data.json`, written by the plain
  `writeFile`/`writeFileSync` path (`:3339`/`:3394`), **not** the ACL-hardened
  `writeSecureFile` (`src/shared/secure-file.ts`). Route DB secrets through
  `writeSecureFile`/a hardened sidecar, or `hardenExistingSecureFile` on
  `orca-data.json`, so a warn-and-store password isn't world-readable on disk.
- Encryption happens in **both** persistence write paths (`writeToDiskAsync` ~`:3321`,
  `writeToDiskSync` ~`:3376`); iterate `dbConnections[]` and encrypt each nested
  password in both, operating on the serialized clone (never mutating `this.state`).

```ts
// src/shared/database-types.ts
export type DbEngine = 'postgres' | 'mysql'
export type DbSslMode = 'disable' | 'verify-full' | 'insecure-no-verify'
export type DbConnection = {
  id: string; name: string; engine: DbEngine
  host: string; port: number; database: string; user: string
  password?: string                  // encrypted at rest; warn-and-store on weak backend
  ssl?: DbSslMode                     // default SMART-BY-HOST: localhost→disable, remote→verify-full; 'insecure-no-verify' explicit opt-in
  readOnly: boolean                  // default FALSE (writable, validated); missing → false on load; confirm-dialog (P5) guards writes
  sshTunnel?: { targetId: string }   // RESERVED — not wired in v1
  createdAt: number; updatedAt: number
}
```

## Related Code Files

- Modify: `src/shared/database-types.ts` — full `DbConnection` (incl. `readOnly`,
  SSL modes) + input/DTO types.
- Modify: `src/main/persistence.ts` — `getDbConnections/.../removeDbConnection`
  (mirror `getSshTargets` ~`:5579`); **strong-backend** encrypt on save in BOTH
  write paths (~`:3321`/`:3376`); strict decrypt on load; normalize on load with
  `readOnly ?? false` (mirror `normalizeSshTarget` ~`:3124`).
- Create: `src/main/database/db-credential-store.ts` — `getSelectedStorageBackend()`
  check, strict encrypt/decrypt, warn-and-store signaling. (Named for what it holds —
  not a `utils` file.)
- Create: `src/main/ipc/database.ts` — `database:list|add|update|remove` +
  `database:encryptionStatus` (drives the form banner).
- Modify: `src/main/ipc/register-core-handlers.ts` — `registerDatabaseHandlers(store)`
  with the `registered` guard, **gated by `isTrustedUIRenderer`** (Phase 3 F15).
- Modify: `src/preload/index.ts` — `window.api.database` namespace.
- Create: `src/renderer/src/store/slices/database.ts` (mirror `slices/ssh.ts`).
- Create: `src/renderer/src/components/database/ConnectionList.tsx`,
  `ConnectionForm.tsx` (engine→default port; SSL select defaulting smart-by-host;
  `readOnly` toggle default off; encryption-unavailable banner); mount in `DatabasePage.tsx`.

## Implementation Steps

1. Flesh out `database-types.ts` (incl. `readOnly` default false, SSL modes).
2. Build `db-credential-store.ts` with `getSelectedStorageBackend()` + strict crypto;
   weak backend = **warn-and-store** (validated) signaled to the form banner.
3. Add `dbConnections` to `PersistedState` + CRUD + encrypt(both paths)/strict-decrypt/
   normalize(`readOnly ?? false`) in `persistence.ts`.
4. Route secret-at-rest through `writeSecureFile`/sidecar or harden `orca-data.json`.
5. Implement `ipc/database.ts` CRUD + `encryptionStatus`; register (trusted-sender gated).
6. Add `window.api.database` to preload; build slice; build `ConnectionList` +
   `ConnectionForm` (smart-by-host SSL default; write-only password; `readOnly` toggle
   default off; banner when encryption weak/unavailable).
7. Tests: round-trip asserts ciphertext != plaintext on strong backend **and** exercises
   the `getSelectedStorageBackend()==='basic_text'`/unavailable branch (warn-and-store,
   not mocked `true`); normalize coerces missing `readOnly` → false and missing `ssl` →
   smart-by-host; CRUD calls `scheduleSave`; both write paths encrypt nested passwords.

## Success Criteria

- [ ] Add/edit/delete connections; list survives restart; `readOnly` defaults writable;
      SSL defaults smart-by-host.
- [ ] Strong-backend machine: password encrypted (assert in test).
- [ ] Weak/absent backend: form shows the banner and stores with consent (warn-and-store);
      no SILENT weak write (test the false branch).
- [ ] Legacy/missing `readOnly` loads writable; missing `ssl` resolves smart-by-host.
- [ ] Typecheck + lint + unit tests green.

## Risk Assessment

- Warn-and-store (validated) writes a weaker secret on keychain-less Linux — the banner
  must be unmistakable so the user understands the at-rest weakness; pair with the
  hardened-file step so it isn't *also* world-readable.
- Schema drift: normalize on load so older `orca-data.json` files don't crash.

## Red Team Hardening (applied)

- **F2 (Critical):** gate on `getSelectedStorageBackend()`; warn-and-store banner
  instead of silent plaintext (no template existed — build the banner).
- **F-decrypt (Medium):** strict fail-closed decrypt for DB creds.
- **F5 (High):** harden the at-rest file (secure-file/sidecar), not ciphertext-only.
- **F3/F7 (Medium):** `readOnly` defined here, default **writable** (validated); missing
  normalizes to writable — the P5 confirm dialog is the write safety net.
- **Two-write-path note:** encrypt nested passwords in both `writeToDiskAsync`/`Sync`.
