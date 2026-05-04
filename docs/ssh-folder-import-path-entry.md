# SSH Folder Picker — Path-Aware Filter

## Problem

On the "Browse remote filesystem" screen, the filter input only searches entries in the current directory. Users who know where they want to go, for example `Documents/orca-internal`, still have to click through each level manually. Typing a path with `/` currently produces "No matches" because the input treats it as a literal filter string.

## Goal

Let the user type a remote folder path like `Documents/orca-internal`, `~/Documents`, `/var/log`, or `../sibling` and navigate there from the existing filter input. The feature should preserve filter-only behavior for users who type ordinary names, avoid request storms over flaky SSH links, and fit the current `RemoteFileBrowser` model where `Select folder` returns the committed current directory.

## Current Implementation Constraints

The renderer entry point is `src/renderer/src/components/sidebar/RemoteFileBrowser.tsx`. Directory loading goes through `window.api.ssh.browseDir`, backed by `src/main/ipc/ssh-browse.ts`.

The browse IPC currently accepts a `dirPath` string and returns `{ resolvedPath, entries }`, where each entry only has `{ name, isDirectory }`. It uses a remote shell command, `cd <path> && pwd && ls -1ap`, not SFTP `readdir`/`stat`. The design below must therefore be implementable using repeated `browseDir` calls. Anything that requires symlink metadata, file type metadata beyond "directory or not", or a cancellable SSH command needs an explicit IPC contract change.

## Design

### Mode Switch

The input has two modes:

- **Filter mode**: ordinary text filters entries in the current directory.
- **Path mode**: path-like text resolves directory segments and uses the final partial segment as the filter in the resolved parent.

Enter path mode when the input:

- contains `/`
- starts with `~/`, `./`, or `../`
- equals `~`, `.`, or `..`

The explicit `..` cases are required because "presence of `/`" alone would make bare `..` behave like a filter instead of parent navigation.

### Input Parsing

| Input | Meaning |
|---|---|
| `docs` | Filter current directory |
| `Documents/orca-internal` | Resolve `Documents`, then filter by `orca-internal` |
| `Documents/` | Resolve and show `Documents` with no filter |
| `/var/log` | Resolve from remote root |
| `~/Documents` | Resolve from the SSH user's home |
| `..` | Parent of current directory |
| `../sibling` | Parent of current directory, then filter by `sibling` |

Parsing should preserve the raw input. Do not normalize away a trailing slash, because `Documents` and `Documents/` mean different things: the first stays in filter mode until Enter, while the second enters path mode and previews `Documents` with an empty filter. Typing a trailing slash does not by itself commit navigation; Enter, a row click, or a breadcrumb click are the only navigation commit actions.

### Base Path

Resolution starts from:

- `/` for absolute inputs beginning with `/`
- the resolved home directory for inputs beginning with `~`
- the current `resolvedPath` for relative inputs

`browseDir('~')` already resolves the remote user's home and returns the absolute `resolvedPath`. Cache that result, but do not hardcode a home path in the renderer. Treat `~` as a base marker, not as a directory name to match under the current directory.

### Resolution Algorithm

For a path-mode input:

1. Split the input into a base, committed path segments, and a trailing filter segment. A segment is committed when it appears before the final separator or when the input is exactly `~`, `.`, or `..`. Ignore the empty segment created by one leading `/` for absolute paths and by one trailing `/`; other empty segments from repeated separators should produce an inline invalid-path error instead of silently rewriting the user input.
2. Resolve committed segments one at a time from the base path:
   - `.` keeps the current base.
   - `..` moves to the parent path. If already at `/`, stay at `/`.
   - exact directory match descends.
   - exact non-directory match stops resolution and shows an inline error.
   - unique prefix match among directories descends.
   - ambiguous prefix stops resolution and shows an inline error.
   - no directory match stops resolution and shows an inline error.
3. Once committed segments resolve, display that directory's cached or fetched listing.
4. Apply the trailing segment as the local filter in that resolved directory.
5. Keep the raw input intact on errors. Do not clear user text unless navigation is committed by Enter, a row click, or a breadcrumb click.

Path-mode typing must not call the existing `navigate(path)` wrapper directly. It should update separate preview state, for example `{ previewResolvedPath, previewEntries, previewFilter, previewError, previewLoading }`, while leaving the committed `resolvedPath` untouched. Otherwise typing `Documents/` would change the `Select folder` target before the user commits the path. All committed navigation still goes through `navigate(path)` so the committed current directory, breadcrumb, loading state, and `Select folder` target remain consistent.

The list can render the preview listing while path mode is active, but the footer and `Select folder` target should make the committed path clear. A simple implementation is:

- `Select folder` keeps today's behavior and selects the committed `resolvedPath` when the input is empty or in filter mode.
- `Select folder` is disabled while a non-empty path-mode preview is visible. This prevents silently selecting the old committed directory while the list is showing a different preview directory.
- A row click in a preview listing commits navigation relative to `previewResolvedPath`, not the old committed `resolvedPath`.

### Enter Key

In filter mode, keep today's behavior:

- one matching folder navigates into it
- only file matches show the file hint
- ambiguous folder matches do nothing

In path mode:

- fully resolved directory, including a trailing `/`, navigates there and clears the input
- resolved parent plus one matching child folder navigates into that child and clears the input
- resolved parent plus one exact non-directory match shows the file hint or an inline "not a directory" error and does not clear the input
- ambiguous or invalid path keeps the input and shows the inline error

### Backspace Out Of Empty Input

Optional. If implemented, Backspace on an empty input navigates to the parent directory, equivalent to the breadcrumb up button. It should not fire when the caret is inside non-empty text.

### Paste

Pasting a path resolves through the same parser as typing. Treat a paste as one logical operation: start resolving immediately, show loading state, and drop stale results if the user edits before it completes.

## Debouncing And Request Control

### Filter Mode

Filtering is local against the current `entries` array. Do not call `browseDir` for filter-only edits. A 60-100ms render debounce is acceptable for large directories, but it is not required for correctness. If directories can contain thousands of entries, list virtualization is the larger performance fix.

### Path Mode

Remote calls are only needed when a committed segment requires a listing that is not already cached.

Rules:

- Debounce typed path resolution by 250-350ms.
- Do not debounce paste.
- Track a monotonically increasing request id and ignore stale responses. `AbortController` alone is insufficient unless the IPC contract is changed to support cancellation.
- Cache directory listings by `targetId + absolute resolved path` for the lifetime of the picker.
- Reuse the already-loaded current directory listing as the first cache entry.
- Keep committed directory state and preview directory state separate. The existing `genRef` pattern in `RemoteFileBrowser` protects committed `loadDir` calls, but path preview needs its own request id so a stale preview cannot overwrite committed navigation after the user clicks a breadcrumb or row.
- Do not fetch for partial trailing segment changes. For `Documents/orc` to `Documents/orca`, `Documents` is already resolved, so only the local filter changes.
- Keep the previous visible listing while resolving the next directory. Show a subtle spinner in the input instead of flashing the list to empty.

Invariant: ordinary typing should cause at most one uncached `browseDir` call per newly committed path segment. Paste may issue multiple sequential `browseDir` calls, one per uncached segment, because resolving `/home/neil/project` requires proving each intermediate directory.

## Errors And Empty States

Path-mode errors render below the input and do not replace the file list:

- unresolved segment: `Documentz isn't a directory in /home/neil`
- ambiguous segment: `Doc matches multiple directories in /home/neil`
- permission denied: `Permission denied: /home/neil/private`

The current `ssh:browseDir` implementation needs a small correctness fix for this to work reliably. It rejects only when `stderr` is present and `stdout` is empty, but `cd <path> && pwd && ls -1ap` can print `pwd` to stdout and then fail `ls` with permission denied. In that case the handler currently looks like a successful empty directory. The handler should reject on non-zero exit status, or use a command shape that emits a machine-readable status for `ls`, before this PR claims permission-denied handling.

Empty-state copy should distinguish filter emptiness from directory emptiness:

- current directory has no entries: `Empty directory`
- path mode resolved to an empty directory: `/home/neil/Documents is empty`
- filter hides every entry: `No matches for 'orca'`

## Edge Cases

- **Symlinks to directories**: the current IPC cannot identify or follow them reliably while also exposing symlink metadata. Do not promise symlink-specific UI in this PR unless `ssh:browseDir` is changed to return richer entry metadata.
- **Case sensitivity**: the remote listing is authoritative. Exact (case-sensitive) match wins first so users with both `Documents` and `documents` get what they typed. When no case-sensitive match exists, fall back to a case-insensitive exact match, then a case-insensitive unique prefix match. Without this fallback, typing `documents/` errors while `documents` (no slash) finds `Documents` via the filter — the two modes must not disagree.
- **Trailing slash**: `foo/` commits `foo` as a path segment for preview resolution and shows that directory with an empty filter. It does not commit picker navigation until Enter or a row click.
- **Repeated separators**: reject `foo//bar` as invalid in path mode. Silently collapsing it would make the visible input disagree with the path being resolved.
- **Whitespace**: filter mode can continue trimming for search, but path mode must preserve spaces inside segments and should not trim the full input before parsing. Remote paths can legitimately begin or end with spaces.
- **Remote Windows paths**: the current browse command and this design are POSIX-path oriented. Do not add partial `C:\...` support in the renderer without first making `ssh:browseDir` shell/path handling Windows-aware.
- **Names containing `/`**: impossible to represent as path segments. Treat `/` as a separator.

## Tests

Add focused unit tests around a pure parser/resolver helper, then keep `RemoteFileBrowser` tests thin:

- no slash stays in filter mode
- `..` enters path mode and resolves to parent
- `../sibling` resolves parent and filters by `sibling`
- `Documents/orca` resolves `Documents` and filters by `orca`
- `Documents/` previews `Documents` with an empty filter, and Enter navigates into it
- `/var/log` resolves from root
- `~/Documents` resolves from remote home
- `~` resolves and commits the remote home on Enter
- `./child` resolves from the committed current directory
- exact file match in a committed segment reports "not a directory" instead of descending by prefix
- repeated separators report an invalid-path error
- path-mode parsing preserves spaces in segments
- path preview does not change `resolvedPath` or the `Select folder` target before commit
- `Select folder` is disabled while a non-empty path preview is visible
- unique prefix descends
- ambiguous prefix reports an error and does not navigate
- missing segment reports an error and does not clear input
- permission denied from `ls` rejects instead of rendering an empty directory
- stale async resolution result is ignored after input changes
- stale async preview result is ignored after committed navigation
- cached directories are not fetched again
- partial trailing filter edits do not call `browseDir`
- paste resolves immediately and sequentially
- Enter in path mode clears input only after successful navigation
- existing filter-mode Enter behavior is unchanged

## Files To Change

- `src/renderer/src/components/sidebar/remote-file-browser-helpers.ts`: add parser and pure resolution decision helpers.
- `src/renderer/src/components/sidebar/remote-file-browser-helpers.test.ts`: expand coverage for path mode.
- `src/renderer/src/components/sidebar/RemoteFileBrowser.tsx`: wire path mode, cache, request ids, inline errors, loading affordance, and Enter behavior.
- `src/main/ipc/ssh-browse.ts`: fix error reporting so a failed `ls` after a successful `pwd` rejects instead of returning an empty listing. No metadata or cancellation contract change is required for the base path-entry feature.

## Non-Goals

- New UI controls such as a "go to path" button.
- Rich symlink display.
- Remote Windows path support beyond what the current SSH browse command already handles.
- Changing the picker selection model. `Select folder` continues to return the current resolved directory.
