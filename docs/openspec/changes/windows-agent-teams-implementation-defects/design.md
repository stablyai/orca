## Context

Orca does not run tmux. It impersonates one: a private shim directory goes first on `PATH`, a fabricated `TMUX` value is set, and Claude Code's tmux calls are forwarded into `ClaudeAgentTeamsTmuxDispatcher`, which drives Orca's own terminal API. That dispatcher was verified working on Windows before any of this work — `split-window`, `send-keys`, `capture-pane`, `respawn-pane` and `kill-pane` all drive real panes.

Three `win32` guards were removed in earlier commits to reach it. This change covers what was wrong around them.

The governing fact: **nothing on this path had ever been exercised on Windows.** Every defect below is a POSIX assumption that held on macOS and Linux and failed on Windows. That is also the best predictor of where further defects live.

Evidence classes per `CLAUDE.md` §5.

| Finding | Evidence |
|---|---|
| Dispatcher drives real Orca panes on Windows | **verified** — drove five tmux verbs against a live app |
| Shim passed its target's name as argv, so the CLI never dispatched | **verified** — read the argv a recording stub received |
| Shim fabricated `tmux 3.4` on stderr for every call | **verified** — observed on a `send-keys` invocation |
| Integration tests compiled the launcher, not their stub | **verified** — failures carried `OrcaCliLauncher`'s error string |
| PATH-precedence tests asserted only negatives and passed on an error path | source-read |
| A bare `spawn("tmux")` resolves `.exe`, never `.cmd` | **verified** — a competing port answered instead |
| The compiled shim wins that lookup once present | **verified** — both with and without shell resolution |
| `copyFile` preserves mtime on Windows but not POSIX | **verified** (Windows), source-read (POSIX) |
| `builtinModules` omits `sqlite`, `test`, `sea` on Node 22 and 24 | **verified** on both |
| Electron 43 can load `node:sqlite`, and the shipped app already does | **verified** |
| Agent detection carried a fourth `win32` gate | **verified** — detection now returns the agent |
| Native Windows processes expose `Path`, not `PATH` | **verified** |
| Reading `.PATH` truncated the team PATH to one entry | **verified** — 1 entry with `Path`, 60 with `PATH` |
| Electron-as-node has non-TTY stdin in a pane; node does not | **verified** — measured side by side |
| Launching Claude directly fixes the invisible TUI | **inferred** — not yet observed through the UI path |
| Claude Code exposes any way to create a teammate | **not established** — no tool, no slash command found |

## Goals / Non-Goals

**Goals**

- Claude Agent Teams is detectable, launchable, and visibly interactive on Windows.
- The shim reaches the dispatcher with arguments intact, and beats any competing tmux.
- macOS and Linux behavior is unchanged.
- Tests assert the behavior they claim to, so a regression to any of these is caught.

**Non-Goals**

- The same PATH-casing pattern in `terminal-attribution.ts` and `pty.ts`.
- `F1`–`F12` in `send-keys`.
- WSL or SSH-remote native panes.
- Making Electron-as-node hand a real TTY to its children — an upstream problem, avoided rather than worked around.

## Decisions

**Write PATH back under the caller's own key.** Reading either casing fixes the truncation, but emitting `PATH` when the child already carries `Path` leaves two keys with different values and undefined precedence. Resolving the caller's key and overwriting it keeps exactly one. `Path` in, `Path` out.

**Launch Claude directly on Windows rather than through the Orca CLI.** The CLI runs inside Electron-as-node, whose stdin is not a TTY in a pane; an interactive TUI inheriting it never becomes interactive. The PTY path already recognises a direct Claude command and injects the same team environment, so this removes the Electron hop without losing anything. `--teammate-mode auto` is kept explicit in the command so the native-panes intent is readable from the command line and the catalog entry cannot silently start a plain Claude session. The accepted cost is that process recognition, which keys on the literal `claude-teams` token, now labels it plain "Claude".

**Ship an executable shim, not a hardened batch file.** Two independent reasons. Process creation appends `.exe` and never `.cmd`, so a batch-only shim is invisible to a bare-name spawn and a competing tmux wins. And a batch file forwards with `%*`, so cmd.exe re-parses `& | > ^ %` — tolerable for fixed-shape probes, unacceptable for `send-keys`, which carries arbitrary prompt text. The batch shim is retained only so an unbuilt dev tree degrades instead of crashing, and is documented as best-effort rather than relied upon.

**Route batch shim targets through cmd.exe.** The dev path resolves the shim target to `orca-dev.cmd`, which process creation cannot launch directly. Quoting each argument stops cmd reading operators; `%VAR%` still expands there, which is why the packaged path resolves to an `.exe` and runs direct.

**Fix the verifier rather than special-case `node:sqlite`.** `builtinModules` structurally omits prefix-only builtins, so an allowlist entry would rot the moment another such builtin appears. Accepting `isBuiltin(specifier)` resolves the class while still rejecting real packages.

**Stamp mtime after copying the shim.** Comparing size and mtime is the cheap idempotence check, but `copyFile` preserves mtime only on Windows. Setting it explicitly makes the check hold on every platform instead of passing locally and failing in CI.

**Assert positives in the precedence test.** The negative-only assertions passed on the shim's own error path and would have passed for an empty program. Since this test is the entire justification for shipping the executable, it now proves the shim ran *and* forwarded.

## Risks / Trade-offs

**The trigger works; the rendered teammate is what remains unverified.** An earlier draft of this section concluded the trigger did not exist, because every deliberate attempt produced a subagent instead. That was wrong, and the evidence arrived from an unexpected direction: the PowerShell parse errors behind defects 13, 14 and 15 were Claude's *own* teammate commands failing inside panes the shim had already created. Claude does invoke the shim and panes are created. What has still never been seen is a teammate pane that renders a working, interactive TUI — the last defect in the chain blocked deployment of its own fix. The open question is therefore Orca-side and observational, not upstream.

**The TTY fix is inferred, not observed.** The measurement is solid — `stdin.isTTY` false under Electron-as-node, true under node, in the same pane — and direct launches rendered their TUI every time. But "changing the launch command makes the TUI appear" has not been watched end to end through the UI. That is the first thing to confirm.

**Process labelling regresses cosmetically.** Recognition keys on the `claude-teams` token, so Windows now registers plain "Claude". The functional paths key on the `--teammate-mode auto` flag, so this is believed display-only — unverified, and cheap to fix by teaching recognition the flag.

**Windows-only tests do not run in the main gate.** `pr.yml` pins `ubuntu-latest`. Scenarios that need a real PE binary or real process creation are developer-run unless a Windows job is added. Scenarios that can inject platform state should be written that way so at least the logic is covered on Linux.

**Local builds depend on two workarounds.** The machine has no MSVC toolset, so native modules cannot be rebuilt for Electron's ABI; an ABI-148 binary was reused from the installed app, and `electron-builder`'s hardcoded `--force` rebuild was temporarily removed for each package. Neither belongs in the repo, and a clean-room build still needs the C++ workload. Recorded so the next person does not mistake them for the build's normal shape.

**Process observation.** Two of these defects were reported by the user after a build was declared verified, and both had appeared in earlier session output that was read past — a shim-dir-only PATH, and a pane that produced no output and was dismissed as a test artifact. The lesson is narrow and concrete: verification that exercises a component directly does not establish that the user-facing path works, and an unexplained observation is a finding, not noise.
