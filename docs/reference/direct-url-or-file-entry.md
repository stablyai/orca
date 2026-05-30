# Direct URL Or File Entry

## Problem

The tab bar `+` menu only offers fixed actions: terminal, browser, new markdown, and open markdown in `src/renderer/src/components/tab-bar/TabBar.tsx`. It has no text entry point for a user who already knows the URL or file path they want.

Quick Open already loads files for the active worktree through `listRuntimeFiles`, watches the active SSH target status, excludes nested linked worktrees, ranks via `prepareQuickOpenFiles`/`rankQuickOpenFiles`, and opens a selected match with `openFile`. That flow is modal and file-only. It does not live in the `+` menu, does not accept URLs, and cannot create a named new file from the typed query.

The runtime file client has the required local/SSH/runtime primitives, with caveats:

- `listRuntimeFiles(context, { rootPath, excludePaths })` returns relative paths only and can fail for auth, missing provider, ripgrep/size, or stale worktree reasons.
- `statRuntimePath(context, absolutePath)` is a one-path existence/type check.
- `createRuntimePath(context, absolutePath, 'file')` creates a single empty file and creates parent directories on the current local, SSH, and runtime-backed paths. Directory creation has separate no-clobber/recursive semantics elsewhere in the file stack, so v1 should create files directly and not expose directory creation as a separate action.

## Goal

Add an entry field at the top of the tab bar `+` menu so users can type:

1. A URL to open an Orca browser tab.
2. An existing file name/path to open an editor tab.
3. A new relative file path to create in the active worktree and open.

The behavior must work from both the titlebar tab strip and split-group tab strips. File operations must route through `RuntimeFileOperationArgs`; browser/editor creation must preserve the target group.

## Non-goals

- Do not replace global Quick Open.
- Do not add persisted launcher state.
- Do not support standalone directory creation.
- Do not open external URLs outside Orca.
- Do not make URL/file detection configurable.

## Design

1. Add a `TabBarCreateEntry` surface inside `TabBar`'s dropdown content above the fixed rows. Use the existing `DropdownMenu` shell, but render the input in a plain form/container, not as a `DropdownMenuItem`; Radix menu item typeahead/selection should not own text input keystrokes. Stop propagation only where required for input typing, and close the dropdown only after a successful submit.

2. Extend `TabBarProps` with a presentation callback that resolves success by returning and failure by throwing:

   ```ts
   onOpenEntry?: (args: { query: string; worktreeId: string; groupId: string }) => Promise<void>
   ```

   `TabBar` owns input text, pending state, focus, and dropdown close behavior. It does not create browser tabs or files. `groupId` should be `groupId ?? worktreeId`, matching the existing `resolvedGroupId` fallback.

3. Add a small hook/helper pair instead of duplicating Quick Open logic:

   - `useTabEntryFileList` loads the file list when the menu opens, using the same inputs as `QuickOpen`: active worktree path, `getConnectionId(worktreeId)`, nested worktree exclusions, and active SSH target status. It cancels stale requests on close or key changes.
   - A pure classifier/opening helper accepts the query, file-list snapshot, load/error state, worktree metadata, runtime context, and target group.

4. Wire the callback in both owners:

   - `Terminal.tsx` titlebar fallback resolves the current active worktree and target group the same way `handleNewTab` / `handleNewBrowserTab` do.
   - `useTabGroupWorkspaceModel` passes its explicit `worktreeId` and `groupId`. Do not rely on ambient `activeGroupIdByWorktree`; split-group `+` can be invoked from an unfocused group.

5. Classify submissions in this order:

   - Empty after trim: reject inline.
   - Explicit URL: accept only `http://` and `https://` URLs with a parseable host.
   - Existing file: once the file-list snapshot is ready, normalize query separators for matching, prefer exact relative-path match, then exact basename match, then `rankQuickOpenFiles`. Before opening, `statRuntimePath` the matched absolute path and reject directories/stale missing matches instead of blindly opening stale list entries.
   - Host-like URL: only after there is no existing file match, accept strict bare hosts such as `example.com`, `localhost:3000`, or `127.0.0.1:3000`, normalized to `https://...` when no scheme is present. Do not run host-like URL parsing for bare input containing `/` or `\`; `new URL('https://docs/readme.md')` parses, so parsing alone is not a path/file guard. Also reject common source/document filename extensions such as `md`, `ts`, `tsx`, `js`, `jsx`, `json`, `yml`, `yaml`, `toml`, `css`, `html`, and `py` so `README.md` and `src/foo.test.ts` stay file/create candidates.
   - New file: only after file listing has completed successfully with no existing-file match and no host-like URL match. Treat the query as a relative worktree path. If listing fails, allow explicit `http://` / `https://` URLs only; keep bare host-like inputs blocked because they cannot be disambiguated from files.

6. Validate new file paths before joining:

   - Reject POSIX absolute paths, Windows drive paths, UNC paths, `~`, empty path, trailing slash, control characters, `.` / `..` segments, and empty raw segments such as `a//b`.
   - Normalize `\` to `/` only after absolute-path checks, then run segment validation on the normalized path too so traversal like `a\..\b` is still rejected.
   - Build the absolute path with `joinPath(worktreePath, relativePath)`, then create with `createRuntimePath(context, absolutePath, 'file')`.
   - On `EEXIST` / "exists", immediately `statRuntimePath`; if it is now a file, open it. If it is a directory, show an error. This handles another window/process winning the create race.

7. Open actions:

   - URL: in paired web clients, call `createWebRuntimeSessionBrowserTab({ worktreeId, url, targetGroupId: groupId })`; otherwise call `createBrowserTab(worktreeId, url, { activate: true, targetGroupId: groupId, title: url })`. Do not use `openNewBrowserTabInActiveWorkspace`; it only opens the default URL.
   - Existing/new file: call `openFile(fileInfo, { preview: false, targetGroupId: groupId })` with `language: detectLanguage(relativePath)`. Include the active runtime environment owner as `runtimeEnvironmentId` through the normal `openFile` fallback; do not suppress runtime ownership.

8. Preserve current fixed actions. Existing `New Terminal`, `New Browser Tab`, `New Markdown`, `Open Markdown...`, and quick-launch rows remain below the entry and keep their current shortcuts/icons.

9. Surface errors with existing toast or compact inline text. Keep the dropdown open and preserve the query on validation/runtime errors. For Quick Open's special ripgrep guidance, either extract its parser/UI deliberately or show the cleaned error string; do not duplicate a private parser inline.

## Data Flow

- User opens the `+` menu.
- `TabBarCreateEntry` focuses the input and `useTabEntryFileList` starts/reuses the menu-local file-list request.
- User types; the menu may show the best existing-file match or "create file" affordance based on the current snapshot.
- Enter calls `onOpenEntry({ query, worktreeId, groupId })`.
- Helper classifies and dispatches:
  - URL -> browser tab creation with target group.
  - Existing file -> stat matched path -> `openFile(..., { targetGroupId })`.
  - New file -> validate -> `createRuntimePath(..., 'file')` -> `openFile(..., { targetGroupId })`.
- Success closes the dropdown. Failure keeps it open.

## Edge Cases

- No active worktree: disable the entry, including URL entry, because Orca browser tabs are worktree-scoped.
- SSH/runtime connection not ready: mirror Quick Open by keying the list request on active target status. Non-URL submissions are disabled while loading/connecting to avoid creating a duplicate before the real list arrives.
- File listing failure: explicit `http://` / `https://` URL submissions still work; file and bare host-like submissions are blocked with the cleaned list error.
- Ambiguous host-like/file names: an existing listed file wins over bare host-like URL normalization. Explicit `http://` or `https://` input is the escape hatch when the user wants a browser tab despite a file-name collision.
- File list stale because another window/process added or removed a file: stat before opening matched files; handle create `EEXIST` by stat-and-open.
- Existing directory match: show an error; do not open as an editor tab.
- Internal spaces in file paths are allowed. Leading/trailing whitespace is trimmed. Control characters are rejected.
- Windows-style separators match existing relative paths after normalization, but Windows absolute and UNC paths are rejected for creation.
- Duplicate Enter while pending is disabled.
- Browser creation in paired web/mobile clients must use `createWebRuntimeSessionBrowserTab`; local desktop uses `createBrowserTab`.
- External file-watch invalidation is not required for v1. The menu-local list reloads on each open and on worktree/connection/status changes; successful create can close the menu without mutating the list.

## Test Plan

- Unit test URL classification: schemes, host-like domains, localhost/IP ports, listed file named `example.com` winning over host-like normalization, `README.md`/`readme.md`, `src/foo.test.ts`, `docs/readme.md`, whitespace, and invalid schemes.
- Unit test path validation: Windows/POSIX absolute paths, UNC, `~`, traversal, empty segments, trailing slash, control characters, spaces, and separator normalization.
- Unit test existing-file selection with `prepareQuickOpenFiles`/`rankQuickOpenFiles`: exact path beats basename, basename beats fuzzy, stale stat failure blocks open, directory stat blocks open.
- Unit/helper test new-file creation with `RuntimeFileOperationArgs`, `createRuntimePath`, `statRuntimePath`, EEXIST stat-and-open, and SSH/runtime connection context.
- Component test `TabBar`: input renders above fixed rows, focuses on open, typing does not close the menu, Enter awaits the callback, success closes, failure preserves text, fixed actions still fire.
- Store/model tests: titlebar and split-group callbacks pass `targetGroupId`; URL creation uses `createWebRuntimeSessionBrowserTab` in web runtime and `createBrowserTab` otherwise.
- Electron validation: open URL, open existing file by exact path/name, create nested new file, invalid traversal/absolute path error, and smoke-test existing menu actions.

## UI Quality Bar

- Follow `docs/STYLEGUIDE.md` and existing `DropdownMenu`/`Input` tokens. Do not add custom colors, shadows, or a modal-like panel inside the menu.
- The input is the first focus target and must not break menu keyboarding.
- The menu remains compact; loading, match preview, create preview, and error rows fit at the current menu width without overlap or awkward height jumps.
- Long typed paths scroll/truncate within the input; fixed rows retain icons, shortcuts, hover states, and dense spacing.

## Review Screenshots

Attach evidence to the PR conversation; do not commit images.

1. `+` menu open in a normal workspace with the entry focused and fixed rows visible.
2. Typed URL state.
3. Typed existing-file query with visible best match.
4. Typed new-file path/create state.
5. Rejected absolute/traversal path error.
6. Adjacent-feature smoke: fixed menu rows still visible and aligned.

## Rollout

1. Add classifier/path-validation helper and tests.
2. Add menu-local file-list hook by extracting the reusable Quick Open loading inputs, not by copying private UI-only parsing.
3. Add `TabBarCreateEntry` and wire it into `TabBar`.
4. Add titlebar and split-group callbacks.
5. Add component/store tests.
6. Run typecheck, lint, targeted tests, UI review, and Electron validation with screenshots.

## Lightweight Eng Review

- Scope: Correctly scoped to the tab bar `+` menu. The implementation must not mutate Quick Open behavior except for extracting reusable search/listing code.
- Architecture/data flow: Good if `TabBar` stays presentational and all worktree/runtime/group decisions live in owners plus a shared helper. The original `onOpenEntry(query, groupId?)` shape was under-specified; include `worktreeId` and a resolved `groupId`.
- Failure modes: Must explicitly handle loading list, failed list, stale list, directory matches, create races, no active worktree, no SSH provider yet, and paired web runtime browser creation.
- Feasibility: Specific URL browser tabs cannot go through `openNewBrowserTabInActiveWorkspace` because that action uses the default URL. `createRuntimePath(..., 'file')` is feasible and creates parent directories for current local/SSH/runtime paths, but do not expose recursive directory creation as a separate v1 behavior.
- Concurrency/invalidation: A menu-local file list is acceptable if every matched file is statted before open and `EEXIST` is handled on create. No global cache is needed.
- Performance/blast radius: Listing on menu open has Quick Open's cost class, but the menu is more casually opened than the modal; cancel stale loads and key requests tightly by worktree path, connection, exclusions, and SSH status.
- Tests: Add pure helper tests first; then component and store/model tests. Electron screenshots are required because Radix menu focus/input behavior is the highest-risk UI part.
- Residual risk: Host-like URL heuristics can surprise users. Keep the heuristic narrow and prefer file matches over host-like normalization whenever the query contains path separators or matches a listed file.
