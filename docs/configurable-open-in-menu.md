# Configurable Open In Menu

## Current behavior (code-checked)

- `WorktreeOpenInMenu` renders exactly two entries: `VS Code` and platform file manager (`Finder`/`File Explorer`/`File Manager`).
- `openWorktreePath()` blocks local launches for remote/server context via `isLocalPathOpenBlocked(...)` before IPC.
- Renderer calls `window.api.shell.openInExternalEditor(path)` with one argument only.
- Preload/API types expose `openInExternalEditor(path: string)` only.
- Main IPC `shell:openInExternalEditor` always launches hardcoded `code` (via `resolveCliCommand('code')`), validates absolute+exists path, and returns `{ ok: false, reason: 'not-absolute' | 'not-found' | 'launch-failed' }` on failure.
- Settings persistence currently shallow-merges most fields. Only `notifications` and `telemetry` are deep-merged in main; renderer deep-merges `notifications`, `telemetry`, and `voice` locally.
- `settings:set` returns the merged settings object, but the renderer currently ignores that return value and applies its own optimistic merge.

## Goal

Add configurable extra editor launchers (Cursor, Zed, custom) to the worktree sidebar `Open in` submenu while preserving:

- VS Code as fixed default entry.
- existing local-path blocking for remote/SSH/server contexts.
- existing path validation and failure-to-toast behavior.

## Non-goals

- No remote editor launching.
- No command existence checks during settings editing.
- No shell template expansion, env interpolation, per-launcher cwd overrides, or argv parsing.
- No removal/configuration of the built-in VS Code row.

## Data model

Add to `GlobalSettings`:

- `openInApplications?: OpenInApplication[]`
- `type OpenInApplication = { id: string; label: string; command: string }`

Default in `getDefaultSettings()`:

- `openInApplications: []`

Why optional in type but present in defaults: keeps backward compatibility with older persisted files while giving runtime code a stable default after merge.

## Normalization contract

Implement one shared normalizer in `src/shared/` and use it in both renderer update path and main persistence update path. It must run in main before persistence.

Rules:

- trim `label`/`command`.
- drop rows with empty `label` or empty `command`.
- drop rows with duplicate `id` (keep first).
- if `id` is missing/blank, generate one (e.g. `crypto.randomUUID()` in renderer before save).
- cap length (e.g. 8).

Do not dedupe by `command`: users may intentionally keep separate labels for the same command with different wrappers/scripts later.

Main remains source of truth. Renderer normalization is UX only; main normalization must always run.

Also normalize on load (not only on `settings:set`) so externally edited/stale persisted rows are repaired on startup.

## IPC and launch behavior

Change signature across shared preload surface and main handler:

- `openInExternalEditor(path: string, command?: string)`

Main launch behavior:

- if `command` is missing/blank after trim, fall back to `code`.
- otherwise resolve and launch that command token (same resolution path currently used for `code` via `resolveCliCommand`).
- keep existing `validateLocalPathTarget(...)` path checks.
- keep `getSpawnArgsForWindows(command, [path])` path for Windows.
- keep detached spawn semantics and `launch-failed` mapping.

Constraint to document in UI copy: command is not shell-parsed. `cursor --new-window` is treated as a binary name and will fail. Users must provide an executable command (or wrapper script) only.

Important: this is not “free”. Every call site and type layer (`preload/index.ts`, `preload/api-types.ts`, renderer callers, `shell.test.ts`) must be updated together.

## Menu behavior

`WorktreeOpenInMenu` order:

1. `VS Code` (fixed)
2. configured `openInApplications`
3. file manager

Each configured row invokes `openInExternalEditor(worktreePath, app.command)`.

Remote/local guard stays exactly where it is now (`openWorktreePath`) so all rows (including file manager) remain blocked consistently in remote contexts.

## Settings UI

Add General section: `Open In Menu`.

- static note: VS Code is always included.
- presets: add Cursor (`cursor`) and Zed (`zed`).
- editable rows for label/command.
- remove row.
- add custom row.

Search indexing: add entries in `general-search.ts` so settings search can discover this section.

## Consistency and concurrency

- Multi-window: renderer has a `settings:changed` listener, but main currently emits that event only for View > Appearance toggles. `settings:set` does not broadcast generic updates. So edits to `openInApplications` in one window are not guaranteed to appear live in another until reload/fetch.
- Renderer optimistic merge is temporary UI state only. Main write result is authoritative and may normalize away invalid rows. Use the `settings:set` return value to rebase local state immediately after each write.
- Concurrent edits are last-write-wins at the field level (`openInApplications` array replaced wholesale). There is no compare-and-swap/version guard.
- External file mutation of `orca-data.json` is only observed on app restart; no live file watch exists.

## Edge cases

- Empty/whitespace command or label -> dropped by normalizer.
- Missing `openInApplications` in persisted settings -> treated as `[]` via defaults merge.
- Duplicate IDs (including hand-edited config) -> first survives, later rows dropped.
- Command strings with spaces/flags (e.g. `cursor --foo`) -> fail at spawn unless provided via wrapper executable.
- Launcher not in PATH or non-executable -> `launch-failed` and existing toast.
- Path exists but is a file (not directory) still passes current validation and will be passed to launcher/file manager; this is existing behavior.
- Relative/non-existent worktree path -> existing `not-absolute`/`not-found` error flow.
- Remote/server worktree -> blocked before IPC regardless of configured launchers.

## Tests required

- `shell.test.ts`: optional command path, blank command fallback to `code`, Windows spawn arg path, failure mapping.
- `WorktreeOpenInMenu.test.tsx`: configured rows render in order, command forwarded, remote guard still blocks all targets.
- settings normalization tests (shared normalizer + persistence update path): trim, drop invalid rows, cap, duplicate-id behavior.
- settings normalization tests: missing/blank id handling and generated-id stability on edit.
- `settings:set`/renderer integration test: renderer applies authoritative returned settings, not only optimistic local merge.
- General settings search entries include new section keywords.
