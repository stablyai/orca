# Design: Scoped Terminal History In Orca Worktrees

## 1. Problem Statement

The terminal "up arrow" history inside an Orca worktree currently surfaces commands from other worktrees. This is incorrect for Orca's worktree model because switching to a different worktree should not bring unrelated shell history into the current console session.

The immediate symptom is visible from a fresh shell prompt:

- Open terminal in worktree A
- Run a few commands
- Open terminal in worktree B
- Press `ArrowUp`
- Commands from worktree A appear in worktree B

The current implementation already scopes PTY `cwd` correctly per worktree, but that is not enough. Shell history lookup is not driven by `cwd`; it is driven by the shell's persisted history backend.

## 2. Root Cause

The issue is in PTY spawn environment scoping, not renderer key handling.

Relevant current flow:

- [`src/renderer/src/components/terminal/TerminalShell.tsx`](/Users/jinjingliang/Documents/projects/orca/fix-worktree-console-log-crossing/src/renderer/src/components/terminal/TerminalShell.tsx:139) passes the active worktree path as `cwd`.
- [`src/renderer/src/components/terminal-pane/pty-transport.ts`](/Users/jinjingliang/Documents/projects/orca/fix-worktree-console-log-crossing/src/renderer/src/components/terminal-pane/pty-transport.ts:273) forwards that `cwd` into `window.api.pty.spawn(...)`.
- [`src/main/ipc/pty.ts`](/Users/jinjingliang/Documents/projects/orca/fix-worktree-console-log-crossing/src/main/ipc/pty.ts:265) builds the child environment from `process.env` plus optional overrides, but does not override shell history configuration.

That means each spawned login shell still uses the user's default shared history location:

- `zsh` defaults to `~/.zsh_history`
- `bash` defaults to `~/.bash_history`
- other shells similarly keep global user-level history unless explicitly redirected

So the shell is behaving consistently with its environment; Orca is simply not giving it a scoped history target.

## 3. Goals

- Prevent terminal history from leaking across Orca worktrees.
- Keep the fix narrow to shell history behavior.
- Preserve normal user shell startup and config loading.
- Keep the implementation cross-platform for macOS, Linux, and Windows.
- Preserve explicit user-provided history overrides when Orca is not the source of truth.

## 4. Non-Goals

- Replacing the user's shell history system entirely.
- Re-implementing shell history in Orca's renderer or terminal state store.
- Changing `HOME`, `USERPROFILE`, or other broad shell identity paths.
- Solving pane-level isolation in the first iteration.

## 5. Scope Decision

Two scopes were considered:

### Per-pane

Advantages:

- Strongest isolation boundary.
- Matches the strictest interpretation of "each terminal is independent."

Disadvantages:

- Requires threading a stable pane identity all the way into PTY spawn.
- Pane identity is more lifecycle-coupled: splits, remounts, reconnects, and layout restore all complicate the meaning of "same pane."
- Harder to reason about persistence across restart.

### Per-worktree

Advantages:

- Matches Orca's main working boundary.
- Worktree identity is already stable and available where PTYs are created.
- Much simpler to implement and test.
- Still fixes the reported cross-worktree leak.

Disadvantages:

- Two terminals in the same worktree will share history.
  - **Concurrent Writes:** If two panes in the same worktree use the same `HISTFILE`, their histories might overwrite each other when the shell exits, unless specific shell options are enabled (e.g., `shopt -s histappend` for Bash, or `setopt inc_append_history` / `share_history` for Zsh). Phase 1 relies on users already having these standard options enabled in their `.bashrc` or `.zshrc`. Note: this is the same behavior as the current global history (where all terminals share `~/.zsh_history`), so there is no regression. Users who experience last-write-wins today will experience the same thing within a worktree — the only change is that the blast radius is reduced from "all worktrees" to "same worktree."

### Decision

Implement per-worktree history scoping first.

Why: it fixes the actual leak with the smallest and safest change, and Orca already has stable worktree identity. If stricter isolation is desired later, the design should be extended to support a `pane` mode behind the same helper abstraction rather than designing around pane identity from the start.

## 6. Industry Comparison: Ghostty, VS Code, and Others

Neither Ghostty nor VS Code implements per-project history isolation. However, both are useful design references because they modify shell startup behavior narrowly, and both handle the exact `HISTFILE` concern Orca faces.

### 6.1 Ghostty

Ghostty's shell integration ([ghostty-org/ghostty on GitHub](https://github.com/ghostty-org/ghostty)) uses per-shell injection mechanisms:

| Shell | Mechanism | Key Pattern |
|-------|-----------|-------------|
| **zsh** | `ZDOTDIR` redirect to Ghostty's dir; zsh auto-sources `.zshenv` there. Original `ZDOTDIR` saved as `GHOSTTY_ZSH_ZDOTDIR` and restored immediately. | Deferred init via `precmd_functions` — runs last, after all user init files. |
| **bash** | Rewrites command to `bash --posix`; sets `ENV` to `ghostty.bash`. Script exits POSIX mode and re-sources normal startup files. | Checks `if env.get("HISTFILE") == null` before setting — never clobbers user's HISTFILE. |
| **fish** | Prepends to `XDG_DATA_DIRS`; fish auto-loads `vendor_conf.d/*.fish`. | Deferred setup on first `fish_prompt` event; self-erases after running. |

Performance patterns:

- **Stack-allocated buffers**: `std.heap.stackFallback(4096, alloc)` avoids heap allocation for command strings in the common case. Falls back to heap only when env vars exceed 4KB.
- **Comptime feature sort**: Feature list serialization is sorted at compile time — zero runtime cost.
- **O_CLOEXEC for TTY fd**: Prevents fd leaks to child processes.
- **Deferred init**: Both zsh and fish defer hook installation to precmd/first-prompt, avoiding overhead during initial startup parse. The deferred init function is `unfunction`-ed after running to free memory.

HISTFILE handling: Ghostty only touches HISTFILE for bash (to fix the POSIX-mode default of `~/.sh_history`), and only when `HISTFILE` is not already set. It does not touch HISTFILE for zsh.

### 6.2 VS Code

VS Code's terminal shell integration ([`src/vs/platform/terminal/node/terminalEnvironment.ts`](https://github.com/microsoft/vscode)) uses:

| Shell | Mechanism | Key Pattern |
|-------|-----------|-------------|
| **zsh** | `ZDOTDIR` redirect to a per-user tmp dir (`{tmpdir}/{username}-{appname}-zsh`), with `chmod 0o1700` (sticky bit). Four integration scripts copied as `.zshenv`, `.zshrc`, `.zprofile`, `.zlogin`. | Scripts chain back to user files via `USER_ZDOTDIR`. `.zshrc` explicitly sets `HISTFILE=$USER_ZDOTDIR/.zsh_history` before sourcing user's `.zshrc` — because ZDOTDIR redirect would otherwise move HISTFILE to the tmp dir. |
| **bash** | `--init-file` pointing to integration script. Script re-sources user's `.bashrc`/`.bash_profile`. | `VSCODE_SHELL_LOGIN=1` flag for login shell detection. |
| **fish** | `--init-command 'source "{appRoot}/.../shellIntegration.fish"'` | Direct source, no XDG manipulation. |
| **pwsh** | `-noexit -command '. "{appRoot}/.../shellIntegration.ps1"'` | Bundled PSReadLine for accessibility mode. |

Shell detection: VS Code uses `path.basename(executable)` matched against static maps (`posixShellTypeMap`, `generalShellTypeMap`). On Windows, it walks the PTY process tree via `windows-process-tree`.

Performance: The `start()` method is async. For zsh, the ZDOTDIR tmp directory and 4 script files are created/copied once per session (not per-terminal). Subsequent terminals reuse the existing directory. For bash/fish/pwsh, no file I/O is needed — the script path is passed as a command argument.

VS Code does **not** scope HISTFILE per-workspace. Its only history isolation is the AI-tool terminal feature (`VSCODE_PREVENT_SHELL_HISTORY=1`), which uses `HISTCONTROL=ignorespace` / `HIST_IGNORE_SPACE` to prevent commands from being recorded.

### 6.3 Other Terminal Emulators

| Emulator | HISTFILE Approach | Notes |
|----------|------------------|-------|
| **Kitty** | Checks `if 'HISTFILE' not in env` before setting. Uses ZDOTDIR for zsh. | Same pattern as Ghostty. |
| **WezTerm** | Does not touch HISTFILE at all. | Relies on bash-preexec for hooks. |
| **Warp** | Does not isolate HISTFILE. | Has open issues ([#7432](https://github.com/warpdotdev/Warp/issues/7432), [#3692](https://github.com/warpdotdev/Warp/issues/3692)) about AI prompts leaking into shell history. |

### 6.4 Takeaways for Orca

1. **Check before setting**: All well-implemented terminals guard `HISTFILE` with `if not already set`. Orca should follow this pattern — if the caller already provided `HISTFILE` in `args.env`, preserve it.
2. **Env-var injection for HISTFILE is the industry standard for Phase 1**: No terminal emulator uses ZDOTDIR injection *solely* for history scoping. ZDOTDIR is used for broader shell integration (prompt hooks, OSC sequences, etc.).
3. **Do not redirect `HOME`**: Both VS Code and Ghostty avoid this. Orca should too (see §11).
4. **Performance: avoid blocking I/O in the spawn hot path**: Both VS Code and Ghostty minimize or defer file operations. Orca's `ensureHistoryDir` should use `mkdirSync` with `{ recursive: true }` (fast, single syscall when dir exists) rather than async mkdir that would complicate the synchronous IPC handler.
5. **Deferred init is the gold standard**: If Orca later adds broader shell integration (Phase 3), follow the Ghostty/VS Code pattern of deferring hook setup to precmd/first-prompt.

## 7. Proposed Approach

Add a small main-process helper that computes a scoped history target for a worktree and injects shell-specific history settings into the PTY spawn environment.

### 7.1 Data Model

Introduce a helper module, for example:

- `src/main/terminal-history.ts`

Responsibilities:

- compute a stable history scope key for a worktree
- build a safe filesystem location for Orca-managed history files
- apply shell-specific history env overrides to the PTY child env
- leave unknown shells untouched

### 7.2 History Storage Location

Store Orca-managed history under Electron `userData`, for example:

- `<userData>/terminal-history/<encoded-worktree-key>/`

Example files inside that directory:

- `zsh_history`
- `bash_history`
- `powershell_history.txt`

Why this location (and not inside `.git/`):

- Orca owns it — no risk of git operations or hooks interfering with history files.
- No writes into the repository — `.git/` directories can be on different filesystems (e.g., WSL), have restrictive permissions in CI/corporate environments, or be shared between tools that inspect `.git/` contents. Writing Orca state there couples terminal behavior to git internals.
- `.git/` is per-worktree only for linked worktrees — the main worktree's `.git/` is a directory, but linked worktrees have a `.git` *file* pointing to `.git/worktrees/<name>/`. Storing history relative to `.git` requires handling both layouts.
- `git worktree remove` does clean up `.git/worktrees/<name>/`, which would auto-delete history — but only for successful removals. Orphaned worktrees (the `isOrphanedWorktreeError` path in `orca-runtime.ts:746`) use `rm -rf` on the worktree directory, which would not clean up `.git/worktrees/<name>/` history either.
- Stable across app restarts.
- Avoids polluting the user's global dotfiles.

The directory name should not use a raw filesystem path directly. The Orca `worktreeId` format is `${repoId}::${path}` (e.g., `repo-1::/Users/foo/worktree-a`), which contains characters that are illegal in directory names on all platforms (`:`, `/`, `\`). Use a stable hash of the `worktreeId` (e.g., first 16 hex characters of a SHA-256 digest) as the directory name.

Why SHA-256: Node.js `crypto` module includes SHA-256 natively — no external dependency needed. Performance is not a concern since the hash is computed once per PTY spawn (~microseconds). A simpler hash like FNV or xxHash would also work, but SHA-256 avoids introducing a new dependency for marginal performance gain on a non-hot path.

A hash is preferred over slug-based sanitization because:

- It guarantees uniqueness regardless of input character set.
- It produces fixed-length directory names, avoiding filesystem path length limits.
- Two worktreeIds that differ only in subtle path normalization (trailing slash, case on macOS) will not silently collide.

Collision risk: 16 hex characters = 64 bits of entropy. Birthday problem requires ~2^32 (~4 billion) worktrees for a 50% collision chance. For any real usage, collision is astronomically unlikely. If a collision did occur, two worktrees would share history — confusing but not data-destroying.

Canonicalization note: the `worktreeId` is constructed as `${repoId}::${git.path}` where `git.path` comes from `git worktree list` output. Git returns canonical absolute paths, so the same worktree always produces the same `worktreeId`. This is verified by the existing `mergeWorktrees()` logic in `worktree-logic.ts:151`.

To preserve debuggability, write a `meta.json` file alongside the history files (not in a central index):

```json
{ "worktreeId": "repo-1::/Users/foo/worktree-a", "createdAt": "2026-04-13T..." }
```

Why per-directory instead of a single index file: per-directory `meta.json` avoids file locking (concurrent PTY spawns can create directories independently), eliminates single-point-of-corruption risk (one corrupt index would affect all worktrees), and makes the GC simpler (enumerate directories, read each `meta.json`, compare with known worktrees). The tradeoff is slightly more filesystem entries, which is negligible for the expected number of worktrees.

### 7.3 Failure Policy

**All history setup operations must be non-fatal.** If any step in the history scoping pipeline fails — directory creation, seeding, env injection — the PTY spawn must proceed with no history override, degrading gracefully to the current shared-history behavior. Specifically:

- `ensureHistoryDir` (mkdir): catch errors, log a warning, skip HISTFILE injection.
- Seed copy: catch errors (file not found, permission denied, disk full), log a warning, continue with an empty scoped history file.
- Hash computation: cannot fail for valid string input.

Why: a broken terminal is far worse than shared history. Users with 10–30+ worktrees will hit edge cases (disk full, permission issues on corporate machines) that must not brick their workflow.

### 7.4 File Permissions

On Unix (macOS, Linux), history directories should be created with mode `0o700` and history files with mode `0o600` (user-only read/write). In practice, Electron's `userData` directory already has user-only permissions on all platforms, so files created within it inherit appropriate permissions by default. The `mkdirSync` call should use `{ recursive: true, mode: 0o700 }` to be explicit.

Why: shell history can contain sensitive information (tokens accidentally pasted, API keys in curl commands, passwords in environment variable assignments). User-only permissions prevent other users on shared machines from reading history files.

### 7.5 Performance Budget

History scoping adds work to the PTY spawn hot path. The budget is **< 5ms** additional latency per spawn.

Current spawn flow in `pty.ts:199` is synchronous within the `ipcMain.handle` callback. All history operations must remain synchronous to avoid complicating this flow:

- `crypto.createHash('sha256').update(worktreeId).digest('hex')` — ~microseconds, negligible.
- `mkdirSync(histDir, { recursive: true })` — single syscall when directory exists (returns immediately), ~1ms when creating. Following Ghostty's philosophy: avoid async where the operation is fast and the call site is synchronous.
- `existsSync(histFile)` for seed check — single stat syscall, ~microseconds.
- Seed copy (first spawn only): `readFileSync` tail + `writeFileSync` — bounded to 500KB, ~2-5ms on SSD. Paid once per worktree lifetime.

Total: ~0.1ms for subsequent spawns (hash + mkdir no-op), ~5ms for first spawn with seeding. Well within budget.

### 7.6 Lifecycle and Garbage Collection

Worktrees are transient in Orca. To avoid unbounded disk space usage from orphaned history files, Orca must clean up these directories when a worktree is removed.

**Active cleanup hook**: Add `deleteWorktreeHistoryDir(worktreeId)` in the `worktrees:remove` IPC handler (`src/main/ipc/worktrees.ts`), after `store.removeWorktreeMeta(args.worktreeId)` on both the success path (line 262) and the orphan cleanup path (line 255). This is a `rm -rf <userData>/terminal-history/<encoded-worktree-key>/` operation — non-fatal if it fails.

**Background Garbage Collection:** Relying solely on a deletion hook can leave orphaned directories if the app crashes during worktree removal. Orca should run a lightweight background GC on app startup.

GC ordering: GC **must run after live worktree enumeration is complete** — i.e., after all repos have been enumerated and `git worktree list` has been merged into Orca's runtime view. If GC runs before all repos are loaded, it would see worktree IDs that haven't been enumerated yet and incorrectly delete their history directories.

GC implementation:
1. Read all subdirectories of `<userData>/terminal-history/`.
2. For each, read `meta.json` to get the `worktreeId`.
3. Cross-reference with the set of all **live** `worktreeId`s from worktree enumeration (`worktrees:listAll` or equivalent main-process aggregation of `fetchWorktrees(repoId)` results), not `store.getWorktreeMeta()`.
4. If the `worktreeId` is not in the known set, delete the directory.
5. Log deletions for diagnostics.

Why not `store.getWorktreeMeta()`: persisted worktree metadata is sparse in Orca. A worktree only gets an entry when the user edits metadata such as comment, display name, archive state, unread state, or sort order. A valid worktree with no authored metadata does **not** appear there. Using `worktreeMeta` as the GC source of truth would therefore incorrectly delete history for untouched but still-live worktrees.

GC cost: linear scan of directories + one `meta.json` read per directory. For 50 worktrees, this is ~50 stat + 50 small file reads — negligible (~5ms). Schedule GC as a `setTimeout(..., 10_000)` after workspace hydration to avoid competing with startup-critical I/O.

**Disk usage estimate**: Each seeded history directory is ~500KB (10K-line seed). For 50 worktrees, total is ~25MB. With GC cleaning up deleted worktrees, steady-state usage stays proportional to active worktrees.

## 8. PTY Spawn Changes

Orca's PTY spawn API currently accepts `cwd` and optional `env`. To scope history reliably, the main process should also know which worktree is being launched.

### Required renderer-to-main change

Extend PTY spawn arguments to include:

- `worktreeId` (optional string)

This is preferable to deriving identity from `cwd` because:

- `worktreeId` is Orca's canonical identity
- it is already used throughout tab/worktree state
- two paths that normalize differently should still map to the same Orca worktree identity

**All PTY spawn call sites must be updated to pass `worktreeId`:**

1. **`src/renderer/src/components/terminal-pane/pty-transport.ts:273`** — the `createIpcPtyTransport` factory receives `cwd` and `env` from `pty-connection.ts:149`. The `worktreeId` is available in the `pty-connection.ts` caller via `deps.worktreeId`. Thread it through `IpcPtyTransportOptions` into the `window.api.pty.spawn()` call.

2. **`src/renderer/src/store/slices/terminals.ts:944`** — the eager startup spawn path. The `worktreeId` is already in scope from the worktree iteration loop (`worktree.id` at line 963).

3. **`src/preload/index.ts:183-188`** — the Electron preload bridge type must add `worktreeId?: string` to the spawn options object. To prevent type drift between preload and main-process handler, define the spawn args interface in `src/shared/types.ts` and import it from both locations. Electron's structured-clone IPC silently drops properties that are not on the receiving end's expected type, so type mismatch here would cause `worktreeId` to be silently `undefined` in the main process — history scoping would degrade gracefully (no override) but the bug would be hard to diagnose.

**Fallback when `worktreeId` is absent:** If `worktreeId` is undefined or empty (e.g., a hypothetical future "detached terminal" feature, or a spawn triggered before workspace hydration), skip all history scoping and spawn with the default shared history. This matches the current behavior and avoids surprising failures. The `worktreeId` field is intentionally optional in the IPC contract for this reason.

### Main-process behavior

In [`src/main/ipc/pty.ts`](/Users/jinjingliang/Documents/projects/orca/fix-worktree-console-log-crossing/src/main/ipc/pty.ts:200):

1. Check the `terminalScopeHistoryByWorktree` setting (§10.1). If disabled, skip steps 2-5.
2. Build the current `spawnEnv` as today.
3. Resolve the launched shell kind from the **effective child shell**, not just `basename(shellPath)`.

   - On normal macOS/Linux launches, `basename(shellPath)` is sufficient.
   - On native Windows launches, `basename(shellPath)` still distinguishes `cmd.exe`, `pwsh.exe`, and `powershell.exe`.
   - On **WSL launches**, the outer executable is always `wsl.exe` in the current implementation (`pty.ts:221-228`), so `basename(shellPath)` would misclassify the session as an unknown shell and skip history injection. For WSL, shell detection must instead use the inner command Orca launches (`bash -c ... exec bash -l` in Phase 1), so the resolved shell kind is `bash`.

   Match against known shell names: `zsh`, `bash`, `fish`, `pwsh`, `powershell`. For edge cases like versioned names (`bash-5.2`, `zsh-5.9`) or nix-store paths (`/nix/store/.../bin/zsh`), use prefix matching on the basename (e.g., `shellName.startsWith('bash')` or `shellName.startsWith('zsh')`). This follows the same `path.basename(executable)` approach used by VS Code (§6.2), with the WSL-specific override above because Orca wraps the real shell in `wsl.exe`.
4. Compute a worktree-scoped history directory.
5. Inject shell-specific overrides into `spawnEnv`.
6. Spawn the shell as normal.

**Shell fallback interaction**: The existing fallback logic (`pty.ts:330-363`) tries `/bin/zsh` → `/bin/bash` → `/bin/sh` if the primary shell fails. History env injection happens *before* the spawn attempt, so if zsh fails and bash takes over, the `HISTFILE` would point to `zsh_history` while bash is running. This is harmless — bash will happily read/write a file named `zsh_history` — but confusing for debugging. To handle this cleanly, inject history env vars before the *first* spawn attempt using the primary shell kind, and if a fallback succeeds, update the `HISTFILE` in `spawnEnv` to match the fallback shell's expected filename (e.g., `bash_history`). Since `spawnEnv` is already mutated during fallback (line 347: `spawnEnv.SHELL = fallback`), this is a natural extension.

## 9. Shell-Specific Rules

### Zsh

Set:

- `HISTFILE=<orca-history-dir>/zsh_history`

This works because environment variables set by the parent process are inherited by the child shell before any startup file runs. When Orca sets `HISTFILE` in the PTY spawn environment, zsh has access to it from the moment it starts — before `.zshenv`, `.zshrc`, or any other startup file is sourced. From the zsh documentation (zshparam(1)): "If `HISTFILE` is not set when the shell initializes, the default is `$ZDOTDIR/.zsh_history` or `$HOME/.zsh_history`."

**Framework compatibility**: The two dominant zsh frameworks both guard against overwriting a pre-set `HISTFILE`:

- **oh-my-zsh** (`lib/history.zsh`): `[ -z "$HISTFILE" ] && HISTFILE="$HOME/.zsh_history"` — only sets HISTFILE if it is currently empty/unset. This was changed from an unconditional assignment in [PR #1663](https://github.com/ohmyzsh/ohmyzsh/pull/1663).
- **Prezto** (`modules/history/init.zsh`): `HISTFILE="${HISTFILE:-${ZDOTDIR:-$HOME}/.zsh_history}"` — preserves the existing value if set.

This means Orca's spawn-time `HISTFILE` will survive both frameworks. The only case where isolation breaks is if a user unconditionally sets `HISTFILE=...` (without a guard) in their `.zshenv` or `.zshrc` outside of a framework. For Phase 1, we accept this as a known limitation affecting a small minority of users. If isolation must be strictly guaranteed later, a `ZDOTDIR` injection script strategy (similar to Ghostty §6.1 and VS Code §6.2) will be required — this is planned for Phase 3.

### Bash

Set:

- `HISTFILE=<orca-history-dir>/bash_history`

This covers normal Unix bash launches and the WSL bash path too. Similar to `zsh`, explicit `HISTFILE` overrides in `.bashrc` will break isolation in Phase 1.

### WSL Bash

Same logical behavior as bash, but the path written into `HISTFILE` must be a Linux path visible inside WSL, not a Windows path.

The current PTY launcher already detects WSL via `parseWslPath(cwd)` and spawns `wsl.exe -d <distro> -- bash -c "cd ... && exec bash -l"` (`pty.ts:221-228`). Phase 1 should align with that implementation instead of introducing a second shell-detection/path-conversion strategy:

1. Detect WSL from `cwd` exactly as the PTY launcher does today.
2. Resolve the shell kind as `bash` for this path, because the inner login shell is explicitly `bash`.
3. Compute the history directory on the **Windows side** under `<userData>/terminal-history-wsl/<distro>/<encoded-worktree-key>/`.
4. Convert that Windows path into a Linux-visible `/mnt/<drive>/...` path before injecting `HISTFILE`.

**Recommended approach**: use `toLinuxPath()` for the path conversion helper, not `getWslHome()`.

Why:

- `getWslHome()` returns a Windows UNC path to the distro home (for example `\\\\wsl.localhost\\Ubuntu\\home\\jin`), not a Linux path. It is suitable for worktree placement logic, but not for building a Linux-side `HISTFILE`.
- `toLinuxPath()` already converts Windows paths into Linux-visible paths for commands that execute inside WSL, including `/mnt/c/...` mappings and UNC WSL paths where needed.
- Storing the history root under Windows `userData` preserves a single GC/diagnostics surface for all shells, including WSL. Orca can create/delete those directories directly from the main process without needing an extra cleanup mechanism inside each distro.

Why not the WSL-home proposal for Phase 1: it would require a second storage root, separate GC behavior, and extra logic to build Linux-native paths from a helper (`getWslHome()`) that deliberately returns Windows UNC paths. That may still be worth revisiting later for performance, but it is not the simplest correct implementation for the current codebase.

### PowerShell / pwsh

PowerShell history is typically mediated through PSReadLine, so a plain env var override is not enough. To avoid brittle CLI argument injection in Windows PTYs, the likely implementation path is:

- Inject a temporary PowerShell profile module or rely on standard `.config` paths rather than command-line arguments.

This can be added in the same abstraction, but it is more intrusive than the zsh/bash cases.

### Fish

Set:

- `fish_history=orca_<worktreeHashPrefix>`

where `<worktreeHashPrefix>` is the same first-16-hex-chars SHA-256 hash used for the history directory name (§7.2).

Fish natively supports scoped history sessions via this environment variable. From the Fish documentation (https://fishshell.com/docs/current/cmds/history.html): "Fish stores history in `$XDG_DATA_HOME/fish/<name>_history` where `<name>` is the value of `$fish_history`." Setting `fish_history` in the environment before the shell starts causes Fish to read/write to `~/.local/share/fish/orca_<hash>_history`.

**Important**: Fish validates `fish_history` via `valid_var_name()` in [`src/common.rs`](https://github.com/fish-shell/fish-shell/blob/master/src/common.rs), which only allows `[a-zA-Z0-9_]`. If the value contains any other character (hyphens, colons, slashes), Fish logs an error and silently falls back to the default `"fish"` session — undoing isolation. This is why the raw `worktreeId` (e.g., `repo-1::/Users/foo/worktree-a`) cannot be used directly. The hex hash prefix is safe because it contains only `[0-9a-f]`.

Fish history files are managed by Fish itself under `$XDG_DATA_HOME/fish/`, not under Orca's `userData`. This means Orca's GC (§7.6) cannot clean them up directly. However, these files are small (Fish deduplicates aggressively) and the `orca_` prefix makes them easy to identify for manual cleanup if needed.

### cmd.exe (Windows Command Prompt)

Do nothing.

Why: `cmd.exe` does not have a `HISTFILE` equivalent. Its command recall is mediated by `doskey` and is session-scoped by default — history does not persist across sessions, so there is no cross-worktree leak to fix. On Windows, `process.env.COMSPEC` typically resolves to `cmd.exe` (not PowerShell), which means this is the default Windows shell path in `pty.ts:237`. This is explicitly deferred, not accidentally overlooked.

### Unknown Shells

Do nothing.

Why: an incorrect generic override is more dangerous than leaving the current behavior unchanged for a less-common shell. This includes shells like `tcsh`, `dash`, `elvish`, and `nushell`, which have varying history mechanisms. Support can be added per-shell as demand arises.

## 10. Override Rules

Orca should not fight explicit user overrides.

Policy:

- If the caller already provided a relevant history override in `args.env`, Orca should preserve it. This follows the industry-standard pattern used by Ghostty, Kitty, and VS Code (§6): check before setting.
- If the user's shell rc later reassigns history settings, the shell config wins.

Why: the Orca fix should establish a better default, not become a hard policy engine that overrides intentional shell customization. The major zsh frameworks (oh-my-zsh, Prezto) guard their `HISTFILE` assignments (§9), so the env-var approach works for the vast majority of users. The remaining risk is users who unconditionally set `HISTFILE` outside a framework — a small minority.

**Diagnostics:** To aid debugging, the history helper should log (to Electron's main-process console, not the terminal) which `HISTFILE` was injected for each PTY spawn, including the resolved shell kind and worktree hash. This makes it easy to verify isolation is working during development and support sessions without adding any user-visible noise.

## 10.1 Feature Flag and Rollback Plan

History scoping is controlled by a `terminalScopeHistoryByWorktree` boolean in `GlobalSettings` (`src/shared/types.ts:439`), defaulting to `true`.

**How to add**: Add the field to the `GlobalSettings` type, add a default in `getDefaultSettings()` (`src/shared/constants.ts:77`), and check it in the history helper before injecting env overrides. The existing `Store.updateSettings()` mechanism (`src/main/persistence.ts:225`) handles persistence automatically, and the `{ ...defaults.settings, ...parsed.settings }` merge in `load()` ensures backward compatibility on upgrade.

**Rollback**: If history scoping causes issues (e.g., shell startup failures with a specific zsh plugin), users can disable it via settings. This immediately stops HISTFILE injection, reverting to shared-history behavior. No app restart is required if the setting is read at PTY spawn time (not cached at startup).

**Emergency rollback**: If a release causes widespread issues, a follow-up release can flip the default to `false`. The setting persists in `orca-data.json`, so users who manually enabled it keep their preference.

## 11. Why Not Change `HOME`

Changing `HOME` or similar identity paths would influence far more than shell history:

- rc file discovery
- git config resolution
- ssh config and keys
- language toolchain caches
- `~` expansion semantics
- user scripts that depend on home-relative paths

That would turn a terminal history bug into a shell-environment behavior fork. The fix needs to stay targeted.

## 12. Audit: Other Cross-Worktree State Leaks

An audit of the PTY spawn environment (`src/main/ipc/pty.ts:265-305`) and common shell state vectors was performed to determine whether other state besides shell history leaks across worktrees. Summary:

### Leaks That Exist But Are Benign (No Action Needed)

| State Vector | Shared? | Why It's OK |
|---|---|---|
| **SSH/GPG agent** (`SSH_AUTH_SOCK`, `GPG_AGENT_INFO`) | Yes, shared via `process.env` | Intentionally shared. Users expect the same SSH keys and GPG identity across all worktrees. Scoping these would break git push/pull. |
| **Git credential cache** (`git credential-cache`) | Yes, shared socket | Intentionally shared. Same repo, same remote credentials. |
| **Language version managers** (nvm, pyenv, rbenv) | Shared initial state, but cwd-aware | These tools detect `.nvmrc`/`.python-version`/`.ruby-version` per-directory. Since Orca correctly sets `cwd` per-worktree, they auto-switch on `cd` or shell init. No leak. |
| **Shell completion caches** (`~/.zcompdump`, `~/.cache/zsh/`) | Yes, shared | Completion caches are global by nature. Scoping them would cause redundant recompilation and slow shell startup. |
| **direnv / `.envrc`** | Per-directory, cwd-aware | direnv hooks fire on `cd` and load `.envrc` from the current directory. Since `cwd` is set correctly, the right `.envrc` loads. No leak. |
| **Shell aliases and functions** (from `.zshrc`, `.bashrc`) | Yes, shared via `HOME` | These are user identity, not worktree state. Scoping would require changing `HOME`, which §11 rules out for good reasons. |

### Leaks That Exist But Are Low-Risk (Monitor, Don't Fix Now)

| State Vector | Shared? | Risk | Notes |
|---|---|---|---|
| **Zsh directory stack** (`~/.zdirs` if `AUTO_PUSHD` is set) | Yes, shared file | Low — most users don't use persistent directory stacks. If they do, `dirs` in worktree B might show paths from worktree A. | Could be scoped via `DIRSTACKFILE` env var if needed in a future phase. |
| **Zoxide / autojump databases** (`~/.local/share/zoxide/db.zo`) | Yes, shared | Low — these tools track frequently-visited directories. Cross-worktree directories appearing in `z` suggestions is mildly confusing but not harmful. | Zoxide supports `_ZO_DATA_DIR` env var for scoping. Not worth the complexity for Phase 1. |
| **Atuin / mcfly** (alternative history tools) | Yes, shared | Medium — users who replaced built-in history with atuin or mcfly will not benefit from HISTFILE scoping at all, since these tools maintain their own databases. | Atuin supports `ATUIN_DB_PATH` env var. Consider adding atuin/mcfly support in Phase 2 alongside fish/PowerShell. |
| **tmux/screen inside Orca terminal** | Inherits scoped HISTFILE | Low — if a user runs tmux inside an Orca PTY, tmux spawns new shells that inherit the scoped `HISTFILE` from the parent environment. This is the desired behavior: all shells within that tmux session write to the worktree-scoped history, since the user initiated tmux from within that worktree's context. |

### Leaks That Do Not Exist (Already Scoped)

| State Vector | Why It's Already OK |
|---|---|
| **Working directory** | `cwd` is set per-worktree at spawn time (`pty.ts:209`). |
| **TERM, COLORTERM, TERM_PROGRAM** | Set to fixed values, not worktree-specific (`pty.ts:268-271`). |
| **CODEX_HOME, OPENCODE_CONFIG_DIR, PI_CODING_AGENT_DIR** | Already scoped per-PTY by existing services (`pty.ts:274-297`). |
| **LANG** | Locale is user identity, not worktree state. Correctly shared. |

### Conclusion

Shell history is the only state vector that (a) leaks across worktrees, (b) is noticeably harmful to users, and (c) can be fixed narrowly without broad environment changes. The other shared state is either intentionally shared (SSH, git credentials), self-correcting via cwd (version managers, direnv), or low-impact enough to defer. This confirms the design's focus on history scoping is the right priority.

## 13. Migration Strategy (Seeding)

To mitigate "Empty History UX Shock" (where users press `ArrowUp` in a new worktree and see nothing), the history helper should **seed** the new worktree history file upon first creation.

Behavior after rollout:

- Existing global shell histories remain untouched.
- When an Orca-managed scoped history file does not exist, Orca copies the user's global `HISTFILE` (if present) into the new scoped target.
- From then on, the worktree terminal writes only to its own scoped history.
- Users keep their global shell history outside Orca, which remains unmodified by worktree sessions.

**Seeding Considerations:**
- **Performance:** Copying a large global history file during PTY spawn could introduce latency on the first terminal launch for a worktree. To bound this cost, seed only the **last 500KB** of the global history file (using a tail-read from the end of the file, not loading the entire file into memory). 500KB is roughly 10K lines of typical commands — enough to give users a rich history while keeping the copy under ~5ms on any modern disk. If the global history file exceeds 10MB, skip seeding entirely and log a diagnostic note. Why 500KB: this balances richness (users can scroll back through recent commands) against spawn latency (see §7.5 performance budget). A byte-based cap is more predictable than a line-based cap because command lengths vary widely (simple `ls` vs. multiline heredocs).
- **Bash timestamp format:** When `HISTTIMEFORMAT` is set, bash writes `#<timestamp>` lines paired with command lines. A naive byte-offset tail could split in the middle of a timestamp-command pair, losing context for the first entry. The tail-read should scan forward from the byte offset to the next `#<timestamp>` marker (a line starting with `#` followed by digits) to avoid splitting pairs. This is a minor edge case — at worst, one command at the boundary loses its timestamp, which is acceptable.
- **Correctness Limitations:** Since seeding evaluates the `HISTFILE` path from the main process *before* the shell starts, it only knows standard defaults (like `~/.bash_history` or `~/.zsh_history`). If the user customized their global history path dynamically in their `.zshrc`, Orca will not find it to perform the initial copy.
- **Failure handling:** If the global history file does not exist, is unreadable, or the copy fails for any reason (disk full, permission denied), continue silently with an empty scoped history. An empty history on first launch is acceptable; a failed PTY spawn is not.

This ensures users do not feel like Orca "deleted" their history when opening a terminal for the first time in a new worktree.

## 14. Test Plan

Add tests around PTY spawn env shaping in [`src/main/ipc/pty.test.ts`](/Users/jinjingliang/Documents/projects/orca/fix-worktree-console-log-crossing/src/main/ipc/pty.test.ts:128).

### Unit tests

- zsh spawn injects a worktree-scoped `HISTFILE`
- bash spawn injects a worktree-scoped `HISTFILE`
- two different worktree IDs produce different history targets
- explicit caller-provided `HISTFILE` is preserved (check-before-set pattern)
- WSL path flow converts the history target into a Linux-visible path
- unknown shells (including cmd.exe) are left unchanged
- missing `worktreeId` results in no history env override (graceful degradation)
- history directory creation failure still spawns a working PTY
- seed copy failure still spawns a working PTY with empty scoped history
- `terminalScopeHistoryByWorktree=false` skips all history injection
- shell fallback (zsh → bash) updates HISTFILE to match fallback shell
- versioned shell names (`bash-5.2`, `zsh-5.9`) are detected correctly via prefix match
- seed tail-read respects byte budget (500KB cap)
- seed tail-read for bash with `HISTTIMEFORMAT` does not split timestamp-command pairs
- hash of same worktreeId is deterministic across calls
- history directory permissions are 0o700 on Unix

### Follow-up tests (Phase 2)

- PowerShell launch applies the PSReadLine history path override
- fish launch sets `fish_history` to `orca_<hashPrefix>` (alphanumeric-only)
- fish `fish_history` value passes Fish's `valid_var_name()` check (`[a-zA-Z0-9_]` only)

### Manual verification

- Open terminal in worktree A, run commands, verify `ArrowUp` recalls them.
- Open terminal in worktree B, verify `ArrowUp` does not show worktree A commands.
- Open a second terminal in worktree A, verify shared worktree history still works.
- Restart Orca and confirm worktree-scoped history persists.
- On Windows, verify both native PowerShell and WSL terminal paths still start correctly.
- Verify `terminalScopeHistoryByWorktree=false` disables scoping (ArrowUp shows global history).
- Verify seeding: first terminal in a new worktree should show recent commands from global history.
- Check Electron main-process logs for `[pty:history]` entries confirming injection.
- Verify with oh-my-zsh: terminal should use scoped HISTFILE (check with `echo $HISTFILE`).

## 15. Rollout Plan

### Phase 1

Ship per-worktree history scoping for:

- `zsh`
- `bash`
- WSL bash

Why: these are the lowest-risk, highest-confidence cases. The env-var-only approach is validated by industry precedent (Ghostty, Kitty, VS Code all use check-before-set for HISTFILE) and by verification that the two dominant zsh frameworks (oh-my-zsh, Prezto) guard their `HISTFILE` assignments. This covers the main observed bug on macOS/Linux.

Includes: feature flag (`terminalScopeHistoryByWorktree`) for rollback (§10.1), diagnostics logging (§17), GC with startup ordering guarantee (§7.6).

### Phase 2

Add shell-specific support for:

- **Fish**: `fish_history=orca_<hashPrefix>` (§9). Low-risk; main complexity is the `[a-zA-Z0-9_]` validation constraint and Fish-managed storage outside `userData`.
- **PowerShell / pwsh**: Requires PSReadLine profile injection or `Set-PSReadLineOption -HistorySavePath`. More intrusive than env-var injection — needs testing across PowerShell 5.1 (Windows PowerShell) and pwsh 7+ (cross-platform).
- **Atuin / mcfly**: Users who replaced built-in history with alternative history tools will not benefit from HISTFILE scoping. Atuin supports `ATUIN_DB_PATH` env var; mcfly supports `MCFLY_HISTFILE`. Consider detecting these tools and injecting their respective env vars.

### Phase 3

If needed, enforce stricter isolation via ZDOTDIR injection:

- Move from env-var-only to a `ZDOTDIR` injection script strategy for zsh (similar to Ghostty §6.1 and VS Code §6.2). This sets `HISTFILE` inside the injected `.zshrc` *after* sourcing the user's `.zshrc`, guaranteeing isolation even when user scripts unconditionally override `HISTFILE`.
- Equivalent `--init-file` or `ENV` injection for bash (similar to Ghostty §6.1).
- Make scope configurable: `worktree` (default) or `pane`. Reuse the same history helper; change only the scope key derivation.

Why defer ZDOTDIR to Phase 3: ZDOTDIR injection is significantly more complex (requires creating/managing tmp directories, chaining 4 startup files for zsh, handling login vs. non-login shells). The env-var approach handles the vast majority of users today. ZDOTDIR becomes necessary only if (a) user reports of isolation failures from unconditional `HISTFILE` overrides reach a meaningful volume, or (b) Orca adds broader shell integration (prompt hooks, OSC sequences) that requires startup script injection anyway.

## 16. Open Questions (Resolved)

- **Whether native Windows PowerShell support should be in the first patch or follow-up.** → Follow-up (Phase 2). PowerShell history is mediated through PSReadLine, which requires profile injection rather than simple env var override. cmd.exe is session-scoped by default and needs no fix (§9).
- **Whether fish support is common enough in Orca's user base to justify inclusion in the first patch.** → Follow-up (Phase 2). The fix is simple (`fish_history` env var) but the `[a-zA-Z0-9_]`-only constraint on session names (§9) and the fact that Fish manages its own history files outside `userData` add testing surface. Fish support is low-risk to add in Phase 2 alongside PowerShell.
- **Whether the UI should later expose the history scope as a user setting.** → Resolved: a `terminalScopeHistoryByWorktree` boolean in `GlobalSettings` is included in Phase 1 as a feature flag and rollback mechanism (§10.1). A user-facing settings UI can be added later if there is demand.

## 17. Observability

### What to log

The history helper should log the following to Electron's main-process console on each PTY spawn:

```
[pty:history] worktreeId=repo-1::... shell=zsh histFile=/path/to/userData/terminal-history/a1b2c3.../zsh_history seeded=true
```

Fields: `worktreeId` (truncated), `shell` (resolved kind), `histFile` (injected path or "none" if skipped), `seeded` (whether this was a first-time seed).

### What to measure at startup

During the GC pass (§7.6), log:

```
[pty:history:gc] totalDirs=12 orphaned=2 pruned=2 totalSizeKB=6144
```

This gives support staff a single log line to diagnose "my disk is full" without manual inspection.

### How to verify isolation is working

For a given user session, search main-process logs for `[pty:history]` entries. Each PTY spawn should show a distinct `histFile` path per `worktreeId`. If two different `worktreeId`s show the same `histFile`, isolation is broken.

## 18. Recommendation

Implement per-worktree history scoping now via shell-specific PTY spawn env injection. This is the narrowest fix that addresses the actual bug, matches Orca's existing data model, and avoids broad shell-environment side effects.

The env-var-only approach is validated by:

1. **Industry precedent**: Ghostty, Kitty, VS Code, and WezTerm all use check-before-set for `HISTFILE`. None uses ZDOTDIR injection solely for history scoping.
2. **Framework compatibility**: oh-my-zsh (since [PR #1663](https://github.com/ohmyzsh/ohmyzsh/pull/1663)) and Prezto both guard their `HISTFILE` assignments, preserving a pre-set value.
3. **Performance**: All operations fit within a < 5ms budget per spawn (§7.5), with seeding paid only once per worktree lifetime.
4. **Safety**: Feature flag (§10.1) provides immediate rollback. All operations are non-fatal (§7.3). Unknown shells are left untouched.

The path to stronger isolation (ZDOTDIR injection, Phase 3) is well-understood from the Ghostty and VS Code implementations documented in §6, and can be pursued if the env-var approach proves insufficient for a meaningful number of users.

### Known tradeoff

History is stored in Orca's `userData`, which is machine-local. If a user moves to a new machine or reinstalls Orca, worktree-scoped history does not follow. This is acceptable because: (a) the global history on the new machine provides a starting point via seeding, (b) shell history is inherently ephemeral and machine-local in all other terminal emulators, and (c) syncing history across machines would require a fundamentally different architecture (cloud storage, conflict resolution) that is out of scope.
