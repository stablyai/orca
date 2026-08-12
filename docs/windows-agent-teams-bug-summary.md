# Why Claude Agent Teams has no panes on Windows

**Sessions:** 2026-07-27 → 2026-07-28 · **Orca:** 1.4.148-rc.1 · **Claude Code:** 2.1.220 (Windows)

> **Status:** the original diagnosis below held up. The *scope* did not — what looked like
> three platform guards turned out to be **16 defects**. This document explains the cause and
> where things stand; the full ledger is `windows-agent-teams-session-fixes.md`.

---

## The short version

The starting theory was half right. tmux *is* the protocol Claude Code speaks — but Orca never runs a tmux binary on any platform. It **impersonates** one. So installing psmux could never have helped, and it was actively in the way.

The immediate cause was three deliberate `process.platform === 'win32'` guards forcing `--teammate-mode in-process`. Removing them was correct and turned out to be roughly a sixth of the work: the code path had never been executed on Windows, so nearly every POSIX assumption around it was also wrong.

---

## Why it happens

### Orca fakes tmux — it does not call it

On macOS and Linux, Orca writes a private `tmux` script into `~/.orca/claude-agent-teams-bin/`, puts that directory first on `PATH`, and sets a **fabricated** `TMUX` value plus `TMUX_PANE`. Claude Code believes it is inside tmux and shells out to `tmux split-window`, `send-keys`, `capture-pane`. Orca intercepts every one and translates it into its own panes:

```text
Claude Code  ──spawn("tmux", …)──▶  shim  ──▶  orca agent-teams-tmux  ──▶  RPC
                                                                            │
                        real Orca panes  ◀──  ClaudeAgentTeamsTmuxDispatcher
```

The giveaway: `tmux -V` returns the hardcoded string `tmux 3.4`. Nothing is executed. A real tmux on `PATH` is not a prerequisite.

### Cause 1 — platform guards

| File | Effect |
|---|---|
| `claude-agent-teams-shim-env.ts:38` | forced in-process, skipped shim setup |
| `cli/handlers/core.ts:62` | `orca claude-teams` threw `unsupported_platform` |
| `orca-runtime.ts:19278` | forced in-process in the launch config |
| `tui-agent-config.ts:62` | **fourth guard, found later** — agent detection skipped Windows, so Settings showed "Available to install" regardless |

### Cause 2 — the shim is invisible to Windows, and psmux steals it

Windows `CreateProcess` appends `.exe` and **never** `.cmd`. Orca's Windows shim was `tmux.cmd`, so a bare `spawn("tmux")` could not see it and instead found whatever tmux port was installed:

```text
spawn("tmux", ["-V"], { shell: false })  ->  tmux 3.3.6   <- psmux wins
spawn("tmux", ["-V"], { shell: true  })  ->  tmux 3.4     <- Orca's shim
```

Fixed by shipping a compiled `tmux.exe`, which also removed a second hazard: a batch shim forwards with `%*`, so cmd.exe re-parses `&`, `|`, `>`, `%` — unacceptable for `send-keys`, which carries arbitrary prompt text.

### Cause 3 — everything else

Twelve further defects, each a POSIX assumption that had never met Windows: `Path` versus `PATH` casing, stdin not being a TTY under Electron-as-node, `copyFile` mtime semantics, prefix-only Node builtins, unmapped `send-keys` key names, and Claude's own teammate command being POSIX shell (`cd … && env … claude …`) executed in PowerShell.

Plus one that is **not a Windows bug at all**: Orca's PTY daemon only refreshes when the app *version string* changes. Every local rebuild carried the same version, so the daemon ran day-old code through every reinstall — which silently prevented the last fix from ever reaching the running process.

---

## What was actually done

- **All four platform guards removed.** Windows now builds the native-panes launch plan and detection reports the agent as installed.
- **A compiled `tmux.exe` shim** ships and is copied into the user shim directory, beating any competing tmux on a bare-name lookup.
- **Claude's teammate command is decomposed** rather than executed as shell syntax: `cd` becomes a working-directory option, `env K=V` merges into the environment, the remainder is a bare command. No shell syntax is emitted, so PowerShell, cmd and Git Bash behave alike.
- **A PowerShell call operator** is prefixed when a command begins with a quoted path.
- Plus the PATH-casing fix, the TTY-safe launch command, the key-mapping table, and several test defects where the suite was green while the feature was broken.

Sixteen in total. The ledger with symptom, cause and fix for each is `windows-agent-teams-session-fixes.md`.

---

## What to do next

1. **Force a daemon refresh.** This is the one thing currently blocking the last fix. Reinstalling does not do it, deleting the directory fails on the locked executable, and killing the daemon alone short-circuits on the completion marker. The marker has already been removed; what remains:

   ```powershell
   Get-Process -Name Orca -ErrorAction SilentlyContinue | Stop-Process -Force
   Get-Process -Name orca-terminal-daemon -ErrorAction SilentlyContinue | Stop-Process -Force
   Start-Sleep -Seconds 3
   Start-Process "$env:LOCALAPPDATA\Programs\orca\Orca.exe"
   ```

2. **Confirm it refreshed** — `%LOCALAPPDATA%\Orca\daemon-host\1.4.148-rc.1\.materialized.json` should show today's `completedAt`, and the daemon PID should have changed.

3. **Ask Claude to create an agent team**, and watch for a teammate opening as a real Orca pane. That outcome has never been observed and is the only thing that closes this out.

4. **If it still fails**, instrument rather than reason: log the exact command string where the daemon hands it to PowerShell. Three fixes in a row were diagnosed correctly and deployed incorrectly; observation beats inference here.

5. **Consider uninstalling psmux.** It does nothing for Orca and is the binary that hijacks the bare-name lookup. Harmless now the `.exe` shim ships, but it buys nothing.

---

## The open question — answered

The original version of this document ended by asking whether Claude Code would invoke Orca's shim at all, noting that no tool or slash command to create a teammate could be found, and that the effort might be moot.

**It invokes it.** The PowerShell errors reported later — `The token '&&' is not a valid statement separator`, and `Get-Content` prompting for a path — are Claude's *own teammate commands* running inside panes the shim had already created. The trigger works; only the command content was wrong.

The mistake is worth keeping: repeated failure to trigger the feature through instrumentation was treated as evidence about the feature, when it was evidence about the instrumentation.

---

## Reference

- Full fix ledger: `windows-agent-teams-session-fixes.md` / `.html`
- Defects 1–12: `docs/superpowers/specs/2026-07-27-windows-agent-teams-implementation-defects.md`
- Defects 13–14: `docs/superpowers/specs/2026-07-27-teammate-command-shell-decomposition.md`
- Defects 15–16: `docs/superpowers/specs/2026-07-28-powershell-invocation-and-daemon-staleness.md`
- OpenSpec: three changes under `docs/openspec/changes/`
