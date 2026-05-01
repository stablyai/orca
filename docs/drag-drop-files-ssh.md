# Design Document: Drag-and-Drop File Import over SSH

## 1. Overview

Orca's file explorer supports dragging external files from the OS into the explorer when working with a local worktree (see `docs/file-explorer-external-drop.md`). However, this feature does not work when connected to an SSH remote. The `fs:importExternalPaths` IPC handler uses Node's local filesystem APIs (`copyFile`, `lstat`, `readdir`, `mkdir`) and has no `connectionId` parameter — the renderer never passes one, and the main process has no code path to route import operations through the SSH filesystem provider.

This document proposes extending the import flow to support SSH connections, enabling users to drop local files onto the explorer and have them uploaded to the remote server.

**Origin:** User feedback — [Slack thread](https://stablygroup.slack.com/archives/C0ASMDT6LQZ/p1777530155421009), [GitHub #200](https://github.com/stablyai/orca-internal/issues/200).

## 2. Current Architecture

### 2.1 Local Import Path

The existing local import flow:

1. **Preload** intercepts native OS `drop` events, extracts `FileList` paths, resolves the destination directory from `data-native-file-drop-dir` DOM markers, and emits one IPC event: `{ target: 'file-explorer', paths, destinationDir }`.
2. **Renderer** (`useFileExplorerImport.ts`) receives the event and calls `window.api.fs.importExternalPaths({ sourcePaths, destDir })`.
3. **Main** (`filesystem-mutations.ts`) runs the import: authorize paths → `lstat` validation → symlink pre-scan → deconflict names → `copyFile`/`recursiveCopyDir`.

All of this is local filesystem only. No `connectionId` is threaded anywhere.

### 2.2 SSH Filesystem Provider

The `SshFilesystemProvider` communicates with a relay binary on the remote host via a JSON-RPC multiplexer (`SshChannelMultiplexer`). It supports:

- `readDir`, `readFile`, `writeFile`, `stat`, `deletePath`, `createFile`, `createDir`, `rename`, `copy`, `realpath`, `search`, `listFiles`, `watch`

`writeFile` accepts a `string` content parameter — it is text-only and unsuitable for binary files (images, compiled assets, etc.).

`copy` is remote-to-remote — it tells the relay to copy a file on the remote side.

### 2.3 Direct SFTP

The codebase already uses direct SFTP for relay deployment (`ssh-relay-deploy-helpers.ts`):

- `uploadFile(sftp, localPath, remotePath)` — streams a local file to the remote via `createReadStream` → `sftp.createWriteStream`.
- `uploadDirectory(sftp, localDir, remoteDir)` — recursively creates directories and uploads files.
- `mkdirSftp(sftp, remotePath)` — creates remote directories.

These helpers use `ssh2`'s `SFTPWrapper` obtained from `SshConnection.sftp()`.

### 2.4 Other SSH-Aware Mutations

Other filesystem mutations (`createFile`, `createDir`, `rename`) already accept `connectionId` and route through `getSshFilesystemProvider()`. The import handler is the exception.

### 2.5 System Context

```
┌──────────────────────────────────────────────────────────┐
│ Renderer (file-explorer)                                 │
│  useFileExplorerImport  ──► IPC: fs:importExternalPaths  │
│    { sourcePaths, destDir, connectionId? }               │
└──────────────────────┬───────────────────────────────────┘
                       │
          ┌────────────▼────────────┐
          │   Main Process          │
          │   filesystem-mutations  │
          │                         │
          │   connectionId present? │
          │     ├─ NO  → local fs   │
          │     │   copyFile / mkdir │
          │     └─ YES → SFTP       │
          │         SshConnection   │
          │           .sftp()       │
          └──────┬──────────┬───────┘
                 │          │
        ┌────────▼──┐  ┌───▼────────────┐
        │ Local FS  │  │  Remote Host   │
        │ (source   │  │  (destination  │
        │  always   │  │   via SFTP)    │
        │  local)   │  │                │
        └───────────┘  └────────────────┘
```

> **Architecture note:** The import handler bypasses `SshFilesystemProvider` and uses `SshConnection.sftp()` directly. This is intentional — the relay's JSON-RPC `fs.writeFile` is text-only and cannot carry binary data without base64 encoding overhead. Future maintainers should not "fix" this to route through the provider.

## 3. Gap Analysis

| Requirement | Local | SSH |
|---|---|---|
| Source path validation (`lstat`) | Local `fs.lstat` | Local `fs.lstat` (source is always local) |
| Symlink pre-scan | Local `fs.readdir` | Local `fs.readdir` (source is always local) |
| Name deconfliction | Local `fs.lstat` on dest | Remote `stat` via relay/SFTP |
| File copy | `fs.copyFile` | SFTP stream upload |
| Directory creation | `fs.mkdir` | SFTP `mkdir` or relay `fs.createDir` |
| Recursive directory copy | Local `readdir` + `copyFile` | Local `readdir` + SFTP upload per file |

Key insight: **source paths are always local** (they come from the user's OS file manager). Only the destination is remote. This means source validation (lstat, symlink pre-scan) stays unchanged — only the copy-to-destination step needs an SSH path.

## 4. Proposed Design

### 4.1 Strategy: Direct SFTP Upload

Use `ssh2`'s SFTP channel directly from the main process, reusing the existing `uploadFile`/`uploadDirectory`/`mkdirSftp` helpers from `ssh-relay-deploy-helpers.ts`. Do NOT route through the relay's JSON-RPC `fs.writeFile` because:

- `fs.writeFile` is text-only (string content over JSON-RPC).
- Binary files (images, PDFs, compiled assets) would require base64 encoding + relay-side decode, adding complexity and ~33% bandwidth overhead.
- The SFTP helpers already exist, are tested, and handle streaming correctly.

### 4.2 IPC Changes

**`api-types.ts`** — Add `connectionId` to the import args:

```ts
importExternalPaths: (args: {
  sourcePaths: string[]
  destDir: string
  connectionId?: string
}) => Promise<{ results: ImportItemResult[] }>
```

**`preload/index.ts`** — Thread `connectionId` through the IPC invoke.

### 4.3 Main-Process Import Handler

Extend the `fs:importExternalPaths` handler in `filesystem-mutations.ts`:

```
if (connectionId) {
  → check SSH connection state; if reconnecting, return user-friendly error
  → guard: if sourcePaths is empty, return { results: [] } immediately
  → get SshConnection from session registry
  → open SFTP channel
  → show indeterminate "Importing files…" toast
  → try:
      run SSH import path (4.4)
    finally:
      close SFTP channel (guaranteed cleanup)
      dismiss toast
else
  → resolveAuthorizedPath(destDir)
  → existing local import path (unchanged)
```

**Implementation constraint — `resolveAuthorizedPath` placement:** The current handler calls `resolveAuthorizedPath(destDir)` unconditionally before any copy work. This must be restructured: move `resolveAuthorizedPath(destDir)` inside the `else` (local) branch. For SSH imports, `destDir` is a remote path that does not exist on the local filesystem, so `resolveAuthorizedPath` will throw. The SSH branch skips local path authorization because remote paths are authorized by the SSH connection boundary itself (see Section 9).

**Connection-state check:** Before attempting `connection.sftp()`, the handler must inspect the connection state. If the connection is in `reconnecting` state, fail early with a toast: _"SSH connection is reconnecting — please try again in a moment."_ This avoids an unhelpful generic "Not connected" SFTP error that gives the user no guidance.

**Empty source paths:** If `sourcePaths` is an empty array, return `{ results: [] }` immediately without opening an SFTP channel. This avoids unnecessary channel overhead for a no-op.

**SFTP channel cleanup:** The SFTP channel opened for the import must be closed on all code paths — success, partial failure, or exception. The handler must use `try/finally` semantics around the upload loop. Note that individual `uploadFile` calls receive the `sftp` handle as a parameter and do not manage its lifecycle; the caller (the import handler) is solely responsible for closing the channel.

**In-progress feedback:** Show an indeterminate "Importing files…" toast when the IPC call begins and dismiss it when the import completes (success or failure). This costs almost nothing to implement and significantly improves the experience on slow connections where network latency makes the drop-to-toast gap noticeable.

### 4.4 SSH Import Pipeline

For each source path in the batch:

1. **Source validation** — unchanged. `lstat` the local source path. Reject symlinks, missing, permission-denied. Pre-scan directories for nested symlinks.

2. **Name deconfliction** — use SFTP `lstat` (not `stat`) on the remote destination to check for collisions, matching the local import's use of `lstat`. This ensures consistent collision semantics: a dangling symlink at the destination is still treated as "name taken." SFTP lstat throws `SSH_FX_NO_SUCH_FILE` (code 2) when the path doesn't exist — use this as the "no collision" signal.

3. **Upload** — for files, use `uploadFile(sftp, localPath, remotePath)`. For directories, use recursive SFTP mkdir + uploadFile. Reuse the existing helpers from `ssh-relay-deploy-helpers.ts` after extracting them to a shared location.

4. **Result reporting** — same per-item `ImportItemResult` schema. The renderer doesn't need to know whether the import went local or SSH.

### 4.5 Accessing the SFTP Channel

The `SshConnection` class already exposes `async sftp(): Promise<SFTPWrapper>`. The import handler needs access to the connection for a given `connectionId`.

Current architecture: `SshRelaySession` owns the connection lifecycle but doesn't directly expose the `SshConnection`. The `getSshFilesystemProvider()` dispatch only returns the `IFilesystemProvider` interface.

Options:

**Option A: Expose `SshConnection` via a session registry.**
Add a `getSshConnection(connectionId)` function that returns the `SshConnection` from the `SshRelaySession` map. The import handler calls `connection.sftp()` directly.

**Option B: Add an `uploadFile` method to `IFilesystemProvider`.**
Extend the provider interface with `uploadFile(localPath: string, remotePath: string): Promise<void>` and `uploadDirectory(localDir: string, remoteDir: string): Promise<void>`. The SSH provider implements them via SFTP; the local provider implements them as `copyFile`/`recursiveCopyDir`.

**Recommendation: Option A.** Option B pollutes the provider interface with a local↔remote transfer concern that only applies to import. The relay-based provider should stay focused on remote-side operations. A direct SFTP path from the import handler is simpler and keeps the provider interface clean.

### 4.6 Renderer Changes

**`useFileExplorerImport.ts`** — Pass `connectionId` from the active worktree:

```ts
const connectionId = getConnectionId(activeWorktreeIdRef.current) ?? undefined
const { results } = await window.api.fs.importExternalPaths({
  sourcePaths: paths,
  destDir: destinationDir,
  connectionId
})
```

This is the only renderer change needed. The rest of the import UX (drag state, highlight, toast, reveal) works identically for local and SSH.

### 4.7 Helper Extraction

Move `uploadFile`, `uploadDirectory`, and `mkdirSftp` from `ssh-relay-deploy-helpers.ts` to a shared module (e.g., `src/main/ssh/sftp-upload.ts`). The relay deploy code imports from the new location. This avoids coupling the import feature to relay deployment internals.

**Async filesystem calls:** The existing `uploadDirectory` uses `readdirSync` and `statSync`, which block the event loop. During extraction, replace these with their async counterparts (`readdir` with `{ withFileTypes: true }` from `fs/promises`). The local import's `recursiveCopyDir` already uses async fs calls and serves as the template for this conversion.

## 5. Symlink Policy

Unchanged from the local import design. Source-side symlinks are rejected before upload begins. The pre-scan uses local `readdir` + `lstat`, which works identically regardless of the destination being local or remote.

## 6. Conflict Policy

Same as local: non-destructive, prompt-free deconfliction. The difference is that collision checks use SFTP `lstat` instead of local `lstat`. Using `lstat` (rather than `stat`) matches the local path's semantics: a symlink at the destination is treated as a collision even if its target doesn't exist.

SFTP lstat error handling:

- `SSH_FX_NO_SUCH_FILE` (status code 2) → no collision, name is available.
- `SSH_FX_PERMISSION_DENIED` (status code 3) → fail the item.
- Any other error → fail the item with the error message.

## 7. Performance Considerations

### 7.1 SFTP Channel Lifecycle

Open one SFTP channel per import gesture, not per file. Close it after all items are uploaded using `try/finally` to guarantee cleanup even on partial failure. Opening an SFTP subsystem has ~100ms overhead per channel due to the SSH handshake.

### 7.2 Sequential vs. Parallel Upload

v1: sequential upload (one file at a time). This matches the existing relay deploy behavior and avoids SFTP channel contention. SFTP supports multiple concurrent operations, but managing parallel uploads with error handling and progress adds complexity that isn't needed for v1.

### 7.3 Large File Handling

`uploadFile` uses `createReadStream` → `sftp.createWriteStream`, which streams data rather than buffering entire files into memory. This handles large files without OOM risk.

### 7.4 Network Latency

Unlike local imports, SSH imports are bounded by network throughput. For large drops, the user may see a noticeable delay between the drop gesture and the toast/reveal. v1 includes an indeterminate "Importing files…" toast during the upload to bridge this gap. Granular per-file progress UI is deferred to v2.

## 8. Error Handling

Same per-item error reporting as local imports, plus SSH-specific failures:

- **SSH connection in `reconnecting` state at drop time:** Fail immediately with toast: _"SSH connection is reconnecting — please try again in a moment."_ Do not attempt to open an SFTP channel.
- **SSH connection lost during upload:** Fail remaining items. Partially uploaded files may be left on the remote — acceptable for v1 since partial files are visible in the explorer and can be deleted manually.
- **SFTP channel failure:** Fail the entire import. The `finally` block still runs to release the channel handle.
- **Remote disk full:** SFTP write stream error — fail the affected item.
- **Permission denied on remote directory:** Fail the affected item.

Toast messages remain the same format:

- `Imported 5 items to ~/project/src`
- `Imported 4 items to ~/project/src. 1 item was skipped.`
- `Could not import dropped items`
- `SSH connection is reconnecting — please try again in a moment`

### 8.1 Data Flow Paths

**Happy path:** Renderer sends `{ sourcePaths: ["/a.txt"], destDir: "/remote/dir", connectionId: "abc" }` → main checks connection state (connected) → opens SFTP → shows "Importing files…" toast → validates source locally → deconflicts name via SFTP stat → uploads via SFTP stream → closes SFTP → dismisses toast → returns `{ results: [{ path: "/remote/dir/a.txt", status: "ok" }] }` → renderer shows success toast and reveals file.

**Empty sourcePaths:** Renderer sends `{ sourcePaths: [], destDir: "/remote/dir", connectionId: "abc" }` → main returns `{ results: [] }` immediately, no SFTP channel opened, no toast shown.

**Nil connectionId (local fallback):** Renderer sends `{ sourcePaths: [...], destDir: "/local/dir" }` → main takes existing local import path unchanged.

**Error — reconnecting:** Renderer sends `{ sourcePaths: [...], destDir: "/remote/dir", connectionId: "abc" }` → main checks connection state → state is `reconnecting` → returns error → renderer shows "SSH connection is reconnecting — please try again in a moment" toast.

**Error — mid-upload failure:** Main opens SFTP → uploads file 1 OK → file 2 throws (e.g., permission denied) → file 2 marked as failed → file 3 continues → SFTP closed in `finally` → toast dismissed → returns mixed results → renderer shows "Imported 2 items … 1 item was skipped."

## 9. Security

- Source paths are still authorized via `authorizeExternalPath()` — unchanged.
- Destination paths on the remote are not subject to local path authorization (they're on the remote host). The SSH connection itself is the authorization boundary.
- SFTP operations run under the SSH user's permissions on the remote host.

## 10. Testing

### 10.1 Unit Tests (Main Process)

- SSH import handler routes to SFTP when `connectionId` is present.
- SSH import handler falls back to local import when `connectionId` is absent.
- Empty `sourcePaths` array returns `{ results: [] }` without opening an SFTP channel.
- Reconnecting connection state returns a user-friendly error without attempting SFTP.
- Name deconfliction works with SFTP stat (mock SFTP stat to simulate collisions).
- Source-side symlink rejection works identically for SSH imports.
- SFTP channel is opened once per gesture, not per file.
- SFTP channel is closed after import completes (success or failure) — verify `finally` cleanup runs even when upload throws.
- Partial failure (some files succeed, some fail) returns correct per-item results.
- Indeterminate "Importing files…" toast is shown during upload and dismissed on completion.

### 10.2 Integration Tests

- Drop a single file into an SSH-connected explorer root → file appears on remote.
- Drop a directory into an SSH-connected explorer → directory tree appears on remote.
- Drop a file that collides with an existing remote file → deconflicted name used.
- Drop onto a subdirectory row → file lands in that directory on remote.

### 10.3 Renderer Tests

- `useFileExplorerImport` passes `connectionId` when active worktree has an SSH connection.
- `useFileExplorerImport` passes `undefined` for `connectionId` when local.

## 11. Implementation Plan

1. **Extract SFTP helpers** — Move `uploadFile`, `uploadDirectory`, `mkdirSftp` from `ssh-relay-deploy-helpers.ts` to `src/main/ssh/sftp-upload.ts`. Update relay deploy imports.

2. **Expose SSH connection accessor** — Add `getSshConnection(connectionId)` to the session registry so the import handler can obtain an SFTP channel.

3. **Add `connectionId` to import IPC** — Update `api-types.ts`, `preload/index.ts`, and the `fs:importExternalPaths` handler signature.

4. **Implement SSH import path** — In `filesystem-mutations.ts` (or a new `filesystem-import-ssh.ts`), add the SSH branch: open SFTP → validate sources locally → deconflict names via SFTP stat → upload via SFTP → close SFTP → return results.

5. **Thread `connectionId` in renderer** — Update `useFileExplorerImport.ts` to pass `connectionId` from the active worktree.

6. **Tests** — Unit tests for the SSH import path, integration tests for end-to-end flow.

## 12. Complexity Assessment

**Estimated difficulty: Medium.**

- The hardest part is already done — the local drag-drop UX, preload routing, and renderer import hook all exist and work.
- SFTP upload helpers exist and are proven in relay deployment.
- The main new work is: (a) wiring `connectionId` through the import IPC, (b) implementing SFTP-based name deconfliction, (c) connecting the import handler to the SSH connection's SFTP channel.
- No relay protocol changes needed. No new renderer UI. No new preload routing.
- Risk areas: SFTP error handling edge cases, ensuring the SFTP channel is cleaned up on all code paths, and testing against real SSH servers.

## 13. Open Questions

- Whether v2 should show granular per-file upload progress for SSH imports (v1 includes an indeterminate toast; per-file progress would require tracking bytes transferred).
- Whether partial uploads should be cleaned up on failure (currently left on remote).
- Whether to support drag-and-drop *from* the SSH explorer to the local OS (reverse direction).
