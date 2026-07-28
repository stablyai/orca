## Context

After the teammate-command decomposition, the pane received a bare command naming its executable by quoted absolute path. On Windows that text is not passed as an argument vector — it is appended to an OSC 133 bootstrap and delivered through `-EncodedCommand`, so PowerShell evaluates it as source. A leading quoted token is a string expression there, so nothing was invoked and the following `--` produced a parser error. The reported `line:100` matches the bootstrap length, which is how the delivery path was identified.

The fix was small. Getting it to run was not: three reinstall cycles produced no change, because Orca's PTY daemon executes from a relocated copy that had not been refreshed since the previous day.

| Claim | Evidence |
|---|---|
| PowerShell rejects a leading quoted path followed by `--` | **verified** — parser error names both problems |
| The command is evaluated as PowerShell source via `-EncodedCommand` | source-read, corroborated by the `line:100` offset |
| Orca's own callers already pass invocable commands | source-read — existing tests use `& 'codex' …` |
| The dispatcher cannot see the pane's shell | source-read — no `shellPath` in `orca-runtime.ts` |
| The daemon ran a bundle without the fix | **verified** — daemon chunk built 27/07 lacked the symbol; installed chunk built 28/07 contained it |
| The daemon process survived every reinstall | **verified** — same PID and start time across three cycles |
| Materialisation keys only on the version string | source-read — `getRelocatedDaemonHost` compares `marker.version` to `app.getVersion()` |
| Removing the marker forces a re-copy | source-read — `readMarker` returning null defeats the short-circuit |
| The invocation fix works end to end | **not established** — never observed running |

## Goals / Non-Goals

**Goals**

- A relayed command runs under PowerShell without the relaying layer knowing the shell.
- Commands that are already invocable are untouched.
- The daemon staleness trap is recorded precisely enough to be fixed later or upstreamed.

**Non-Goals**

- cmd.exe support for single-quoted executable paths.
- Changing how Claude Code composes its command.
- Implementing content-aware materialisation in this change.

## Decisions

**Fix invocability where the shell is resolved.** The tmux dispatcher, the agent-teams service and the runtime terminal API all lack `shellPath`; the shell is chosen when the PTY launches. Putting the adjustment there also makes it defensive for every caller rather than only for agent teams, and keeps the relaying layers free of shell knowledge — which is the same principle that made decomposition the right answer for the previous defect.

**Adjust rather than reject.** An alternative was to require callers to supply invocable commands and fail loudly otherwise. Rejected: the offending caller cannot comply, since it relays text composed elsewhere for a POSIX shell.

**Guard against double-prefixing.** Existing callers already pass `& '…'` and `. script.ps1`. The check tests the first non-whitespace character for a quote, so those pass through untouched; a test iterates all three shapes.

**Leave cmd.exe alone.** Claude quotes with single quotes, which cmd treats literally, so a cmd pane would fail differently. Speculatively rewriting quoting for a shell that has not been observed failing risks breaking a working path to fix an imagined one.

**Do not change materialisation in this change.** The correct fix is a content hash, which alters how every Orca installation decides to refresh its daemon — too broad to land as a side effect of a Windows bug hunt, and it deserves its own verification. Recording the behaviour as requirements captures the finding without that risk.

## Risks / Trade-offs

**The invocation fix is unverified.** It is implemented, unit-tested and present in the installed application, but has never been seen to run because staleness blocked it throughout. Treating it as working would repeat the exact error that produced this entry.

**Silent failure is the real hazard in the staleness defect.** Materialisation catches every error and fail-opens, so a refusal to refresh is indistinguishable from being up to date. The visible signal appears far away — a daemon executing old code while the build output, installer and installed application all verify correct. The requirement for observable failure matters more than the content hash, because without it the next occurrence is just as hard to find.

**Diagnosis cost was concentrated in verification method, not analysis.** Three checks passed while the system stayed broken: grepping an asar container rather than extracting from it, grepping a single entry file when the code lived in an imported chunk, and confirming the artifact rather than what the running process executed. Each produced confidence that delayed the real diagnosis. The generalisable rule is that verification must reach the running process; artifact checks establish only that a build is capable of the behaviour.

**Local development on Windows is affected beyond this work.** Any daemon-side change is invisible across same-version rebuilds. Until materialisation is content-aware this needs a documented refresh step, because all three natural remedies — reinstall, delete the directory, kill the daemon — fail, and fail quietly.
