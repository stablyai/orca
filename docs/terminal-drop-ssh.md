# Terminal drag-and-drop over SSH

## Problem

Dragging a local file onto a terminal pane inserts the file's absolute path
into the PTY, so the user can reference it in a CLI or TUI-agent prompt. On
SSH worktrees the terminal runs remotely, so injecting a **local** path
(`/Users/alice/Desktop/log.txt`) is useless — the remote agent has no access
to it.

The file-explorer drop path was fixed in PR #1279 by routing through SFTP
upload (`importExternalPathsSsh`). The terminal drop path was not touched
and still breaks for SSH worktrees.

Reported: https://stablygroup.slack.com/archives/C0ASMDT6LQZ/p1777530155421009

## Goals

- Dropping a local file onto a terminal connected to an SSH worktree makes
  that file available to the remote shell/agent, and injects a path the
  remote process can read.
- Local terminal drops keep their current behavior: reference-in-place, no
  copy, no authorization, no repo pollution.
- Local and SSH paths share one main-side resolver. The renderer may pass
  connection context and show progress UI, but copy/upload/deconfliction
  policy stays out of the renderer so the two modes do not drift over time.

## Non-goals

- Unifying terminal drop with file-explorer drop. They have different
  semantics (explorer always copies into a user-picked `destDir`; terminal
  references a path). They share the SSH upload primitive internally but
  remain separate IPCs.
- Cleanup / garbage collection of staged remote files. Tracked as follow-up
  (see "Follow-ups" below — file **before merging** and replace this
  parenthetical with the issue number so the reference is locatable). Until
  GC lands, files uploaded by a drop whose pane is unmounted before the
  upload resolves are orphaned in `.orca/drops/` with no injected path.
  Users should know uploads are not cancellable.
- Abortable uploads. SFTP transfers run to completion even if the terminal
  pane is unmounted mid-flight.

## Considered: Option A (full unification)

Terminal drop calls `fs:importExternalPaths` with
`destDir = worktreePath`, then injects `result.destPath` into the PTY.
Shares exactly the file-explorer code path.

Rejected because it changes **local** terminal-drop UX: today dropping
`~/Desktop/log.txt` into the terminal pastes `/Users/…/Desktop/log.txt`
so the agent reads the file in place; under Option A the file would be
copied into the repo. Users rely on the reference-in-place behavior to
point agents at files without polluting the worktree.

## Design (Option B)

### New IPC

```
fs:resolveDroppedPathsForAgent({
  paths: string[],
  worktreePath: string,
  connectionId?: string,
}) → {
  resolvedPaths: string[],
  skipped: { sourcePath: string; reason: 'missing' | 'symlink' | 'permission-denied' | 'unsupported' }[],
  failed: { sourcePath: string; reason: string }[],
}
```

Contract:

- **Local (`connectionId == null`):** returns
  `{ resolvedPaths: paths, skipped: [], failed: [] }` unchanged. No copy. No
  authorization (matches today's behavior — the agent's own read is what gets
  authorized, not the drop). Use `args.connectionId == null` (not `!args.connectionId`)
  so an empty string cannot silently pick the local branch.
- **SSH (`connectionId` is a non-empty string):** uploads each path via SFTP
  into a staging dir under the worktree. Returns remote absolute paths for
  items that uploaded successfully, items rejected by policy (symlinks,
  missing sources, permission-denied, unsupported file types) in `skipped`,
  and hard upload errors in `failed`. The split mirrors `ImportItemResult`'s
  existing `'imported' | 'skipped' | 'failed'` and lets the renderer toast
  "Skipped N symlinks" distinctly from "Failed to upload N files." Collapsing
  skipped into failed would mislabel routine policy rejections as errors.

### SSH staging dir

`${worktreePath}/.orca/drops/` on the remote. `.orca/` is reserved as an
Orca-owned directory for future remote state (GC metadata, cached remote
capability probes, etc.); this is its first use. Future features adding
subpaths under `.orca/` should namespace themselves (`.orca/drops/`,
`.orca/<feature>/`) rather than placing files at the root.

Rationale:

- No need to resolve remote `$HOME` (which would require a round-trip and
  caching layer).
- Lives inside the worktree, so cleaned up naturally when the worktree is
  deleted.
- The agent has read access by construction (it runs with the worktree's
  cwd).

The main process must bootstrap `.orca/.gitignore` with `*\n!.gitignore\n`
before the first successful upload. Otherwise every SSH terminal drop dirties
source control with an untracked `.orca/` directory, which recreates the
repo-pollution problem that ruled out Option A for local terminal drops. The
`!.gitignore` negation keeps the marker file itself trackable if we ever want
to (and costs nothing today — `git status` stays clean either way because
nothing tries to add it).

The staging directory must be created recursively over SFTP before upload:

- create `${worktreePath}/.orca` (ignore "already exists")
- write `${worktreePath}/.orca/.gitignore` as `*\n!.gitignore\n` **only if it
  does not already exist** — never overwrite. A user may have added patterns
  there, and silently clobbering user-authored content violates least
  surprise even inside an Orca-owned directory. Use `sftpPathExists` before
  writing. (Two concurrent first-drops racing through the `sftpPathExists`
  check will both write the same bytes — last writer wins, idempotent, so
  the race is benign and not worth locking.)
- create `${worktreePath}/.orca/drops` (ignore "already exists")

Do not rely on `uploadFile`, `uploadDirectory`, or the existing
`mkdirSftp(destPath)` calls to create missing parents. `uploadFile` writes
directly to the final remote file path, and `mkdirSftp` is not recursive, so
the first terminal drop into a fresh SSH worktree would fail if the parents do
not already exist.

### Main-side implementation

`src/main/ipc/filesystem-mutations.ts`:

```ts
ipcMain.handle('fs:resolveDroppedPathsForAgent', async (_e, args) => {
  // Why: `== null` (not `!args.connectionId`) so an empty string is treated
  // as an error from the renderer, not silently routed to the local branch.
  if (args.connectionId == null) {
    return { resolvedPaths: args.paths, skipped: [], failed: [] }
  }
  const worktreePath = args.worktreePath.replace(/\/+$/, '')
  const destDir = `${worktreePath}/.orca/drops`
  const { results } = await importExternalPathsSsh(
    args.paths,
    destDir,
    args.connectionId,
    { ensureDir: true },
  )
  const resolvedPaths: string[] = []
  const skipped: { sourcePath: string; reason: ImportSkipReason }[] = []
  const failed: { sourcePath: string; reason: string }[] = []
  // Iterate in input order so injected paths align with the user's drop order.
  for (const r of results) {
    if (r.status === 'imported') {
      resolvedPaths.push(r.destPath)
    } else if (r.status === 'skipped') {
      skipped.push({ sourcePath: r.sourcePath, reason: r.reason })
    } else {
      failed.push({ sourcePath: r.sourcePath, reason: r.reason })
    }
  }
  return { resolvedPaths, skipped, failed }
})
```

Reuses `importExternalPathsSsh` — SFTP upload, symlink pre-scan, name
deconfliction, per-item error reporting are all already there.

**Staging bootstrap lives inside `importExternalPathsSsh`** behind a new
optional `{ ensureDir?: boolean }` parameter. When set, before the first
upload the function creates `${destDir}`'s parent chain (`.orca`, then
`drops`) and writes `.orca/.gitignore` (`*\n`) only if missing, all on the
**same SFTP session** already opened for the upload. Do not add a separate
`ensureSshDropStagingDir` helper that opens its own channel — that would
double the SFTP handshake cost on every drop.

### Renderer-side implementation

**API change to `shellEscapePath`.** Today the second arg is a *userAgent
string* (substring-matched for `"Windows"`), which couples escape rules to
the client OS. For SSH drops we need to escape for the *target shell*,
which is always POSIX on the remote regardless of client OS. Change the
signature to take an explicit target:

```ts
shellEscapePath(path: string, targetShell: 'posix' | 'windows')
```

Callers derive `targetShell` from context: local drops pass
`isWindowsUserAgent() ? 'windows' : 'posix'`; SSH drops always pass
`'posix'`. This makes test #11 (Windows client → Linux SSH worktree)
correct by construction instead of by coincidence.

**Migration — all three call sites + tests must change together:**

- `src/renderer/src/components/terminal-pane/pane-helpers.ts:53` — update
  signature; drop the `userAgent` default.
- `src/renderer/src/components/terminal-pane/TerminalPane.tsx:937`
  (file-explorer → terminal drop). This is a **local-only** code path
  (explorer drag uses a DOM MIME type that the preload SSH bridge does not
  forward), so pass `isWindowsUserAgent() ? 'windows' : 'posix'` to preserve
  today's behavior exactly.
- `src/renderer/src/components/terminal-pane/use-terminal-pane-global-effects.ts:344`
  — replaced by the new SSH-aware handler below; the `shellEscapePath` call
  moves inside it with an explicit `targetShell`.
- `src/renderer/src/components/terminal-pane/pane-helpers.test.ts` — the
  existing cases pass `'Macintosh'`, `'Linux'`, `'Windows'` as the userAgent
  arg. Rewrite to pass `'posix'` (for Mac/Linux) and `'windows'`, so tests
  exercise the new contract rather than the legacy substring match.

No local behavior changes if this migration is done in one commit: Mac/Linux
already took the POSIX branch via the userAgent string match; Windows
already took the Windows branch. The new signature just names that
explicitly.

`src/renderer/src/components/terminal-pane/use-terminal-pane-global-effects.ts`:

```ts
return window.api.ui.onFileDrop(async (data) => {
  if (data.target !== 'terminal') return
  if (data.paths.length === 0) return
  const manager = managerRef.current
  if (!manager) return
  const pane = manager.getActivePane() ?? manager.getPanes()[0]
  if (!pane) return
  const paneId = pane.id
  const transport = paneTransportsRef.current.get(paneId)
  if (!transport) return

  const wtId = worktreeIdRef.current
  const worktreePath = worktreePathRef.current
  if (!wtId || !worktreePath) return

  // Why: getConnectionId (selector on the terminals/repos slice:
  // `state.repos.find(r => r.id === <worktree's repoId>)?.connectionId`,
  // exposed via the store) returns `string` (SSH), `null` (local repo
  // found), or `undefined` (store not hydrated / worktree not found).
  // Treat `undefined` as an error, not as "local" — otherwise a drop
  // during hydration would silently paste local paths into a remote
  // shell.
  const connectionId = getConnectionId(wtId)
  if (connectionId === undefined) {
    toast.error('Worktree not ready — try again in a moment.')
    return
  }
  const isRemote = connectionId !== null
  const targetShell: 'posix' | 'windows' = isRemote
    ? 'posix'
    : isWindowsUserAgent()
      ? 'windows'
      : 'posix'

  // Local fast path: no IPC round-trip, no toast. Preserves today's
  // zero-latency behavior exactly — same code shape as before, only the
  // shellEscapePath signature is new (and resolves to the same branch).
  if (!isRemote) {
    for (const p of data.paths) {
      transport.sendInput(`${shellEscapePath(p, targetShell)} `)
    }
    pane.terminal.focus()
    return
  }

  const pending = toast.loading(
    `Uploading ${data.paths.length} file(s) to remote…`,
  )
  try {
    const { resolvedPaths, skipped, failed } =
      await window.api.fs.resolveDroppedPathsForAgent({
        paths: data.paths,
        worktreePath,
        connectionId,
      })
    // Why: pane may have unmounted during the SFTP upload (tab closed,
    // worktree switched). Re-check the transport map before writing so
    // we don't call sendInput on a torn-down PTY. Orphaned uploads are
    // acknowledged in Non-goals.
    const liveTransport = paneTransportsRef.current.get(paneId)
    if (liveTransport) {
      // resolvedPaths preserves input order (main-side iterates results in
      // order); injected paths line up with the user's drop gesture.
      for (const p of resolvedPaths) {
        liveTransport.sendInput(`${shellEscapePath(p, targetShell)} `)
      }
      pane.terminal.focus()
    }
    if (skipped.length > 0) {
      const symlinkCount = skipped.filter((s) => s.reason === 'symlink').length
      const noun = skipped.length === 1 ? 'item' : 'items'
      toast.message(
        symlinkCount === skipped.length
          ? `Skipped ${skipped.length} symlink${skipped.length === 1 ? '' : 's'}.`
          : `Skipped ${skipped.length} ${noun}.`,
      )
    }
    if (failed.length > 0) {
      const noun = failed.length === 1 ? 'file' : 'files'
      toast.error(`Failed to upload ${failed.length} ${noun}.`)
    }
  } catch (err) {
    toast.error(extractIpcErrorMessage(err, 'Failed to upload files.'))
  } finally {
    toast.dismiss(pending)
  }
})
```

`extractIpcErrorMessage` is the existing helper at
`src/renderer/src/lib/ipc-error.ts:6` (already used by
`useFileExplorerImport.ts`, `Terminal.tsx`, etc.). Reuse it — do not copy
the body locally.

New dependencies on the hook: `worktreeId` and `worktreePath` refs. Use the
`TerminalPane`'s own `worktreeId` prop, not global `activeWorktreeId`. The
drop listener is already gated by `isActive`, and the pane's own
`worktreeId` is the authoritative identity of the terminal being written
to; reading from global state would race during worktree switches. Promote
this reasoning into a `// Why:` comment at the call site per CLAUDE.md.

Derive `worktreePath` the same way `use-terminal-pane-lifecycle.ts` does
today: find the worktree by `worktreeId` in the store, then fall back to
`cwd`.

### Why not branch in the renderer

- Keeps upload semantics in one place. Adding a second terminal consumer
  (e.g. a standalone TUI pane) should call the same resolver instead of
  deciding where to copy, how to deconflict names, or how to report per-item
  failures.
- The renderer can know that the worktree is SSH for progress UI and shell
  escaping, but it should not know SFTP details or construct uploaded
  destination filenames itself.

### UX details

- **SSH "Uploading…" toast:** SFTP of a few MB can take seconds. Without
  feedback the user thinks the drop failed. Dismiss on success, replace
  with an error toast on failure.
- **Don't inject until upload resolves.** Injecting the remote path before
  the file lands means the agent may try to read a file that doesn't yet
  exist and error. Worth the extra perceived latency.
- **Failure policy:** partial failures still inject the succeeded paths
  and toast the count of failures (same pattern as the explorer).
- **Escape for the terminal that receives the path.** Local drops keep the
  existing platform-specific quoting. SSH drops must use POSIX shell quoting
  for the returned remote paths; do not let a Windows client choose Windows
  quoting for a Linux/macOS SSH shell.

## System fit

```
[Electron preload native drop]
             |
             v
[terminal:file-drop IPC relay]
             |
             v
[active TerminalPane drop handler]
             |
             v
[fs:resolveDroppedPathsForAgent]
      | local                           | SSH
      v                                 v
[return original paths]          [SFTP stage into ${worktreePath}/.orca/drops]
      |                                 |
      |                                 v
      |                          [return remote readable paths]
      |                                 |
      +---------------+-----------------+
                      |
                      v
          [PTY sendInput escaped paths]
```

## Testing

1. Local worktree, drop a single file onto the terminal → original
   absolute path pasted. No copy. No change from today.
2. Local worktree, drop multiple files → each path pasted separated by a
   space. No change from today.
3. SSH worktree, drop a single file → file uploads to
   `${worktreePath}/.orca/drops/<file>` on remote; remote path pasted
   into PTY; agent can read it.
4. SSH worktree, drop a folder → folder uploads recursively; remote dir
   path pasted.
5. SSH worktree, drop a symlink → no injection; toast reads
   "Skipped 1 symlink." (not "Failed to upload") because symlink rejection
   is policy, not error.
6. SSH worktree, drop 5 files where items 2 and 4 are permission-denied at
   the local source → paths 1, 3, 5 are injected **in that order**
   (matching input order), toast says "Skipped 2 items." (permission-denied
   is classified `skipped`, not `failed`, by `importExternalPathsSsh`).
   Additionally, simulate an SFTP write error mid-upload to cover the
   `failed` branch → "Failed to upload N files" toast.
7. SSH worktree disconnected mid-drag → user-visible error toast, no
   partial injection.
8. Name collision: drop the same file twice in quick succession → second
   upload lands as `<name> copy.<ext>` (deconfliction inherited from
   `importExternalPathsSsh`).
9. Fresh SSH worktree with no `.orca` directory → first drop creates
   `.orca/`, `.orca/.gitignore`, and `.orca/drops/`; upload succeeds.
10. After an SSH drop, `git status --short` in the remote worktree does not
   show `.orca/`.
11. Windows client dropping `my file's $draft.txt` into a Linux SSH worktree
   pastes a POSIX-escaped remote path, not Windows double-quoted syntax.
   Expected output for remote path `/home/u/wt/.orca/drops/my file's $draft.txt`:
   `'/home/u/wt/.orca/drops/my file'\''s $draft.txt'` (literal `$draft`
   inside single quotes — no expansion, no backslash-escaping).
16. Local terminal drop on macOS / Linux / Windows clients behaves
    byte-identically to pre-change: same injected string, no toast, no IPC
    call. Run the existing `pane-helpers.test.ts` expectations through the
    new `'posix' | 'windows'` API and confirm outputs match the legacy
    userAgent-based outputs.
17. File-explorer → terminal drop (`TerminalPane.tsx` onDrop) continues to
    work on local and SSH worktrees exactly as today — this path is not
    touched by the new IPC and must still use the explorer's own handling.
12. Empty drop (`data.paths.length === 0`) → no IPC call, no toast, no
   injection. (Possible on some OSes when a drag contains only non-file
   items.)
13. Store unhydrated (`getConnectionId` returns `undefined`) → user-visible
   "Worktree not ready" toast, no injection, no IPC call. Not a silent
   local fallback.
14. Existing user-authored `.orca/.gitignore` with extra patterns → after
   first SSH drop the file is unchanged (bootstrap writes only when
   missing).
15. Unit coverage:
    - preload/API types expose `resolveDroppedPathsForAgent` and the
      channel is registered in the preload `contextBridge` / IPC
      allowlist (regression guard — easy to forget).
    - main IPC covers: local passthrough, SSH success, partial failure
      (order preserved), fresh-worktree staging bootstrap, bootstrap
      preserves existing `.gitignore`, and disconnected SSH.
    - terminal-pane coverage verifies the resolver is called once per
      gesture, no path is injected until the promise resolves, and
      `shellEscapePath` is called with `'posix'` for SSH drops regardless
      of client userAgent.

## Follow-ups

File each of these as a GitHub issue before merging the implementation PR
so "tracked as follow-up" is actually locatable. Inline the issue number
next to each item once filed (e.g. `- GC drops dir (#1301)`), and update
the GC paragraph in Non-goals to point to that issue directly.

- GC `${worktreePath}/.orca/drops/` on worktree delete / disconnect.
- `AbortController` plumbing so unmounting the terminal pane cancels the
  in-flight SFTP upload (related to the pane-unmount guard added in the
  renderer handler: today we no-op the injection, but the bytes still
  transfer).
- Drag-over affordance on the terminal pane (it has the
  `data-native-file-drop-target="terminal"` marker but no hover style),
  so users get feedback that dropping into the terminal is supported.
