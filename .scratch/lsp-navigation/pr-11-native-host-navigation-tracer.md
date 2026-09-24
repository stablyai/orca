## ELI5

When you open a C/C++ file in the Orca editor, you can now hover a symbol to
see its signature, and press F12 to jump to where it's defined — even when the
definition lives in a system header outside your project (e.g. an MSVC STL
file). A background language server (clangd) powers it; this is the first end-
to-end slice (native/Windows host only — WSL and SSH come later).

## What Changed

**Before:** The editor had no code navigation for C/C++. Monaco's built-in
F12 was a no-op across files, and hovering a symbol did nothing.

**After:** Opening a C/C++ file in a local worktree silently starts a clangd
language-server process (one per worktree). Hover shows the markdown signature
(no popup on whitespace); F12 jumps to the definition — project-internal
symbols open as normal tabs, project-external targets (MSVC STL headers) open
read-only. Editing the file keeps the server in sync (incremental, with a
monotonic version counter so out-of-order IPC can't rewind the server).

**Mechanism (new modules):**
- `src/shared/lsp-content-length-framer.ts` — hand-written LSP `Content-Length` framing (Buffer discipline: sticky/split packets, multibyte-safe, bad-frame → session kill).
- `src/main/language-servers/` — JSON-RPC client, native `spawnProcess` adapter, clangd session (initialize handshake + `utf-16` verification + server→client request answers for `workDoneProgress/create` & `workspace/configuration`), launch/binary resolution + existing-`compile_commands.json` detection, session host keyed by worktree root with document routing.
- `src/main/ipc/language-servers.ts` — semantic IPC facade (`languageServers:openDocument/changeDocument/closeDocument/definition/hover` + `languageServers:status` push). No LSP message crosses the renderer boundary.
- `src/preload/api/language-servers-*` — typed bridge wired into `PreloadApi`.
- `src/renderer/src/components/editor/lsp-navigation/` — model→session owner resolution, document-sync bridge (`onDidCreateModel`/`onDidChangeContent`/`onWillDispose` → didOpen/didChange/didClose, per-document IPC pipeline so changes wait for the open), and definition/hover providers + `registerEditorOpener` (the public API F12 needs to leave the current model — standalone `doOpenEditor` refuses cross-file).
- Path normalization shared across renderer/main/URI round-trip (uppercase drive + backslashes, since `Uri.file().fsPath` lowercases the drive).

Compile databases are only **detected** (`build`, `build-cc`, `out`, …), never generated — automation is a later slice. Binary resolution: `ORCA_CLANGD_PATH` env override, else PATH/install-dir discovery (`resolveCliCommand`).

## Why

This is implementation slice S1 of the LSP-navigation spec (ticket 11) — the
minimal end-to-end tracer. The spike (`.scratch/lsp-navigation/spike/`)
already proved the stack against DiligentEngine + clangd 23; this productizes
it (swapping the spike's raw `node:child_process` for `spawnProcess`, the
ratchet gate the spike was exempt from) behind Orca's real IPC/editor/store.

**Design choices from the spec (decisions D1–D10):** the renderer never sees an
LSP message (semantic IPC only); the LSP client lives in the main process with
a thin renderer provider layer; one path-normalize rule is shared everywhere;
`positionEncoding: utf-16` is negotiated and **verified** (clangd defaults to
utf-8 offsets, which corrupt columns on CJK/emoji lines); the document-sync
bridge forwards **every** real model change (user typing, undo, programmatic
reload) — self-write echoes never produce model events because the self-write
registry suppresses the watcher reload chain, so no separate full-text resend
point is needed (model recreation goes through didOpen).

## External file open mechanism — verification (ticket requirement 6)

The "open a project-external header" path was verified against the existing
mechanism (no new file-open code was needed for the happy path; the opener is
the missing piece):

- **Transport exists & is production-used:** `store.openFile({ filePath, relativePath === filePath (external contract), worktreeId, runtimeEnvironmentId: null, readOnly: true }, { forceContentReload, suppressActiveRuntimeFallback })`, preceded by `window.api.fs.authorizeExternalPath({ targetPath })` (in-memory grant). The AI Vault "View Log" flow uses exactly this; the LSP opener reuses it.
- **Read routing:** the external-tab branch of `useEditorPanelFileContentLoader` auto-grants + reads locally via `fs:readFile` — no worktree-membership requirement.
- **Reveal after open:** `setPendingEditorReveal({ filePath, fileId, line, column, matchLength })` — the existing reveal scheduler the opener reuses.
- **Read-only choice for externals:** MSVC STL headers live under `C:\Program Files`; opening them editable would have autosave attempt (and fail with EPERM at) writes there. `readOnly: true` matches the AI Vault precedent and avoids dirty state. A later normal `openFile` of the same path deliberately upgrades to editable (pre-existing behavior).
- **Language gap filled:** `detectLanguage('chrono')` returns `'plaintext'` (no extension). The opener falls back to the source model's language (`cpp`) so extensionless STL headers still highlight.
- **No origin-session marker for local externals:** `externalSshTargetId` exists only for SSH. For local externals the "tab records source session" requirement (D10) is carried implicitly by `worktreeId`, and `isOpenFileOwnedByWorktree` treats such a tab as a full worktree member. This is a convention, not a mechanism — acceptable for S1 (navigation within the source worktree's session).

**Gap that is NOT fixed here (deferred):** cross-owner reuse/migration for the
same absolute path across worktrees (e.g. `findWorkspaceFileRoute` sibling
migration) is not wired into the opener; it always opens in the source
document's worktree. Fine for S1; the S6/S7 WSL/SSH slices revisit host
disambiguation.

## Linked Issue

Fixes #11 (`.scratch/lsp-navigation/issues/11-native-host-navigation-tracer.md`)

## Visual Proof

N/A — no new UI surface; navigation behavior verified via DOM/IPC assertions
in `tests/e2e/editor-lsp-navigation.spec.ts` (hidden-window Playwright CDP,
not screenshots — per the ticket, hidden Electron freezes late visual frames).

## Testing

- [x] I manually tested these changes locally (E2E below)
- [x] Automated tests added/updated

**Unit (72 passing):** `lsp-content-length-framer` (sticky/split/multibyte/bad-frame/`>1MB` header); `language-server-path-normalization` + `uri-mapping` (Windows+POSIX round-trips, drive case, `%`-encoding); `clangd-launch` (`--compile-commands-dir` detection, `ORCA_CLANGD_PATH` override); `lsp-jsonrpc-client` (request/response, server-request answers, timeout, die); `clangd-session` (initialize shape + `utf-16` verification, `workDoneProgress/create` + `workspace/configuration` answers, didOpen/didChange/didClose + version clamp, definition/hover mapping, crash death, shutdown→exit; **plus a real `node -e` child over stdio** proving spawn+framing+no-orphan); `language-server-host` (per-worktree sessions, document routing, status fanout, failed-start degradation); renderer `document-sync` + `providers` (0-based translation, version monotonic, opener in-worktree vs external/STL, refuse non-file/no-owner).
- [x] child-process ratchet test passing — no `node:child_process` direct import outside `src/shared/child-process/`.
- [x] E2E (`tests/e2e/editor-lsp-navigation.spec.ts`, 4 passing, `ORCA_BACKGROUND_LAUNCH=1`): real Orca Electron app + DiligentEngine CMake project + spike's standalone clangd, via `ORCA_CLANGD_PATH`. (a) hover markdown signature on `GetElapsedTime`, null on whitespace; (b) F12 project-internal → `Timer.hpp` tab; (c) F12 `high_resolution_clock` → MSVC STL header opened read-only; (d) insert+undo keeps navigation correct (version monotonic).

**Platforms tested:** Windows (native host, the only host this slice supports). macOS/Linux path-normalization covered by unit tests (POSIX paths pass through); WSL/SSH hosts are out of scope (later slices).

## AI Disclosure

Implemented by an AI coding agent (pi) per the `/implement` skill, following `.scratch/lsp-navigation/` spec + spike.

## Review

- **Security:** new IPC surface is Electron-local (main↔renderer ship atomically; no remote-wire negotiation needed — confirmed against `docs/reference/remote-wire-compatibility.md`). The opener authorizes external paths via the existing `fs:authorizeExternalPath` grant before opening; external targets open read-only.
- **Cross-platform:** normalize handles Windows (drive+backslash) and POSIX (passthrough) paths; no `e.metaKey`/bare-separator assumptions. The `clangd` binary is resolved via the shared `resolveCliCommand` (PATH + version-manager + system dirs).
- **SSH/Mobile:** out of scope for S1 (native host only). The owner-lookup seam (`isLocalNativeEditorFile`) explicitly excludes remote-runtime and SSH-external owners so navigation degrades to "no navigation" (spec D10) rather than mis-routing.
- **Performance:** clangd is one-per-worktree with no idle eviction/caps yet (S2); cold start ~100ms initialize + 1–2s preamble for the first file, then ms-level navigation (spike-measured). The doc-sync bridge serializes per-document IPC on a promise pipeline (changes wait for the open, no lost edits during the startup window).

## Notes

- The e2e spec uses the **real** DiligentEngine project at `D:/zwf/Projects/DiligentEngine` (not the seeded test repo) because navigation needs a real CMake `compile_commands.json`; it's registered via `addRepoPath` at runtime and torn down per-test. It points clangd at the spike's standalone binary via `ORCA_CLANGD_PATH` so the test doesn't depend on a system clangd install.
- Three pnpm global config keys were set on this dev machine during the session (`proxy`/`https-proxy` → `127.0.0.1:7897`, `fetch-timeout=600000`, `fetch-retries=5`) to restore a broken `node_modules` after an interrupted install; they are local to this environment and not part of this PR.

## Checklist

- [x] This PR is small and focused (one slice: native-host LSP navigation tracer)
- [x] I explained what changed and why
- [x] Before/after: N/A (behavior, verified via DOM/IPC assertions)
- [x] Self-reviewed for correctness, security, and performance
- [x] Cross-platform/SSH/path impact considered
- [x] `pnpm typecheck`, `oxlint` (product code), unit + e2e tests pass
