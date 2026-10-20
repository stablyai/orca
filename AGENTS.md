# Useful Commands

- **Typecheck**: `pnpm tc` (or `tc:node` / `tc:cli` / `tc:web`)
- **Test**: `pnpm test [path/to/file.test.ts]`
- **Lint**: `oxlint`, or `pnpm run check:code-quality:changed` for changed files (full `pnpm lint` is slow); format with `pnpm format`
- **Design system**: `pnpm run lint:design-system` for the full renderer report (not a gate); the changed-lines gate above is what CI enforces

# Design System

All UI work — layout, color, typography, spacing, component selection, UX behavior — must follow [`docs/STYLEGUIDE.md`](./docs/STYLEGUIDE.md). Use the tokens defined in `src/renderer/src/assets/main.css` (the canonical source) and the shadcn primitives in `src/renderer/src/components/ui/`. Don't invent new color values, font sizes, or shadow tiers when a documented one already covers the role. When STYLEGUIDE.md is silent, follow the resolution order in its final section.

# Electron UI Validation

Always run tests and agent-launched apps in the background with `ORCA_BACKGROUND_LAUNCH=1`.
Never steal monitor focus or reveal test windows: no `show()`, `showInactive()`, `bringToFront()`,
`app.focus()`, or OS activation. Use CDP screenshots of hidden renderers. Keep native-focus and visible-window tests paused on the user's desktop; run them on an isolated display or CI.
Rebuild modified launch-policy code before running an app; stale build wrappers are not safe.

Use the `$electron` skill and Playwright CDP for rendered Orca UI checks. Do not use computer-use for Orca UI validation.

# Code Style

## Reuse Before Reimplementing

Before writing new logic at any scale — a function, component, IPC channel, state store, or whole subsystem/flow — check whether an existing implementation already does the job. Extend or generalize it instead of building a parallel version.

## Concise/Brief Non-obvious Comments ONLY

- DO NOT: be verbose, explain the obvious, walk through the code ("WHY not HOW")
- BE CONCISE. 1 LINE if possible

## File and Module Naming

Never use vague names like `helpers`, `utils`, `common`, `misc`, or `shared-stuff` for files, folders, or modules. They carry zero info and tend to become dumping grounds. Name files after what they _actually_ contain — prefer the concrete domain concept (e.g. `tab-group-state.ts`, `terminal-orphan-cleanup.ts`) over the generic role (`tabs-helpers.ts`, `terminal-utils.ts`). If you find yourself reaching for `helpers`, the file probably has more than one responsibility and should be split, or there's a better name hiding in the code that describes what the functions operate on.

## Type Assertions: Prefer Checked Types

Avoid type assertions except `as const`. Unavoidable casts need a line-specific `SAFETY:` explanation:

# Considerations

## Worktree Safety

Always use the primary working directory (the worktree) for all file reads and edits. Never follow absolute paths from subagent results that point to the main repo.

## Cross-Platform Support

Orca targets macOS, Linux, and Windows. Keep all platform-dependent behavior behind runtime checks:

- **Keyboard shortcuts**: Never hardcode `e.metaKey`. Use a platform check (`navigator.userAgent.includes('Mac')`) to pick `metaKey` on Mac and `ctrlKey` on Linux/Windows. Electron menu accelerators should use `CmdOrCtrl`.
- **Shortcut labels in UI**: Display `⌘` / `⇧` on Mac and `Ctrl+` / `Shift+` on other platforms.
- **File paths**: Use `path.join` or Electron/Node path utilities — never assume `/` or `\`.
- **Windows terminal shells**: `--shell` picks the shell a terminal _is_; `--command` is typed into whatever shell the host spawned, so a shell choice routed through `command` silently becomes a child process.
- **Windows setup scripts**: the setup/issue-command runner is a `.cmd` batch file unless the script starts with a `#!` line — never derive that from the user's terminal-shell preference, and never launch a `.cmd` runner with a bare `cmd.exe /c` from a Git Bash pane (MSYS rewrites the `/c`).
- **Windows child processes**: start them through `runProcess`/`spawnProcess` from `@orca/process-host` — never `child_process` directly. It pins `windowsHide`, refuses `shell: true`, and encodes `.cmd`/`.bat` arguments so neither `CommandLineToArgvW` nor `cmd.exe` mangles them. Recognised npm/pnpm `.cmd` shims are resolved to their real target so the spawn skips `cmd.exe` entirely.
- **Ripgrep**: Orca bundles `rg` for every platform, WSL, and SSH remotes. Spawn it through `spawnBundledRipgrep` (main) or `resolveRelayRipgrepCommand` (relay), never a bare `'rg'` — Windows resolves a bare name in the spawn cwd before PATH. Don't add git/readdir fallbacks locally; the relay's chain exists only for hosts an upload never reached.
- **Windows process enumeration**: read the table through `src/main/windows/windows-process-table.ts`, never by forking `powershell.exe`.
- **Windows MSYS/Git Bash panes**: their children break away from the per-PTY job unless it is created without `JOB_OBJECT_LIMIT_BREAKAWAY_OK`, and a `conpty.node` built before that fix passes every existing gate.
- **Windows daemon-host relocation**: the terminal daemon runs from a copy of the app runtime under `%LOCALAPPDATA%`, which is what survives an auto-update.
- **macOS daemon launch**: packaged macOS runs the terminal daemon from a copy of the signed terminal host helper through launchd, so an update cannot sever its privacy grants. Before touching that copy, its cleanup, or the fork fallback, read [`docs/reference/macos-daemon-tcc-attribution.md`](./docs/reference/macos-daemon-tcc-attribution.md).
- **Windows EDR signal**: don't add `-ExecutionPolicy Bypass`, `-EncodedCommand`, `cmd.exe /c` with escaped free text, per-operation interpreter spawning, or runtime `Add-Type` compilation without reviewing the EDR impact first — behavioural EDR scores each of those, and being signed does not clear them.
- **WSL commands**: build argv with `buildWslExecArgs` (always `--exec` — under `--`, `wsl.exe` expands `$name` in every argument and silently rewrites the script), and fence anything whose stdout you parse with `buildWslCapturedLoginShellCommand`, because the interactive login shell prints the distro banner to stdout.
- **Linux native modules**: keep the glibc floor at Ubuntu 20.04 / glibc 2.31. A module compiled from source on a newer runner can reference symbol versions absent on the floor and crash the app on startup. Packaging fails if a bundled native binary needs newer glibc.

## Remote Use Case

All changes must consider the remote use case. Don't assume local-only execution.

## Folder Workspace Use Case

All changes must consider folder workspaces as well as git worktrees. Don't assume every workspace is a git worktree.

## Agent Status

The execution host owns agent status in one store, the hook server's, and every reader (sidebar, `worktree ps`, mobile, dashboard) subscribes to it. New producers write into that store, and readers keep only presentation policy.

## Remote Wire Compatibility

Clients and remote Orca servers update independently, so mixed versions are the normal state.

## Git and Review Work

Before running Git or `gh` commands, changing source-control or review behavior, or merging a pull request, read [`docs/reference/git-workflow.md`](./docs/reference/git-workflow.md).
