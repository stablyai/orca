# Claude Agent Teams on Windows — every bug found and fixed

**Sessions:** 2026-07-27 → 2026-07-28 · **Orca:** 1.4.148-rc.1 · **Claude Code:** 2.1.220 (Windows) · **16 defects**

---

## The one-sentence version

Agent Teams didn't work on Windows because of three deliberate platform guards — and once those came out, **sixteen more defects** surfaced: fifteen were POSIX assumptions in code that had never been executed on Windows, and the last one was a deployment cache that quietly prevented the fifteenth fix from ever reaching the running process.

## Why this happened at all

**Root cause class 1 — unexercised platform (defects 1–15).** This code path was written and tested on macOS and Linux, and never run on Windows. Not "poorly written" — unexercised. Every assumption that is true on POSIX and false on Windows survived untested:

| POSIX assumption | Windows reality |
|---|---|
| `process.env.PATH` exists | native processes expose `Path` |
| a spawn finds any executable on PATH | `CreateProcess` appends `.exe`, never `.cmd` |
| `copyFile` doesn't preserve mtime | on Windows it does |
| stdin is a TTY if stdout is | Electron-as-node breaks that pairing |
| env keys are case-sensitive | case-insensitive, so duplicates collide |
| the pane's shell understands `&&` and `env K=V` | PowerShell understands neither |
| `cat` holds a pane open | it's an alias for `Get-Content`, which prompts |
| a quoted path is a command | in PowerShell it's a string expression |

**Root cause class 2 — a cache keyed on the wrong thing (defect 16).** Not a Windows bug at all. Orca's PTY daemon refreshes only when the app *version string* changes. Every local rebuild carries the same version, so the daemon ran day-old code through every reinstall.

The starting misdiagnosis is also worth recording. The theory was *"Orca needs tmux, Windows has none, so I installed psmux."* Orca never runs tmux on any platform — it **impersonates** one: `tmux -V` returns the hardcoded string `tmux 3.4`. So psmux could never have helped, and it proved an active hazard: its real `tmux.exe` wins a bare-name lookup a `.cmd` shim can't compete in.

## The original blocker

Three `process.platform === 'win32'` guards forced `--teammate-mode in-process`:

| File | Effect |
|---|---|
| `claude-agent-teams-shim-env.ts:38` | forced in-process, skipped shim setup |
| `cli/handlers/core.ts:62` | `orca claude-teams` threw `unsupported_platform` |
| `orca-runtime.ts:19278` | forced in-process in the launch config |

Removing them was correct. It was also roughly a sixth of the work.

---

## Group A — Platform assumptions

### 15. A quoted executable path is not a command *(user-reported)*

**Symptom**

```text
At line:100 char:43
+ 'C:\Users\<username>\.local\bin\claude.exe' --agent-id arch-reviewer@sess ...
Unexpected token 'agent-id' in expression or statement.
The '--' operator works only on variables or on properties.
```

**How** — once defects 13/14 removed the POSIX wrapper, the pane's command became a bare `'C:\…\claude.exe' --agent-id …`. On Windows that text is appended to an OSC 133 bootstrap and delivered via `-EncodedCommand`, so it's evaluated as **PowerShell source**. PowerShell reads a leading quoted token as a string literal, then chokes on `--`. The `line:100` is the tell — the bootstrap is ~99 lines.

**Why it survived** — Orca's own callers hand-write invocable commands (`& 'codex' …`). Agent-teams structurally can't: it relays text Claude composed for a POSIX shell.

**Fix** — `ensurePowerShellInvocable` in `windows-shell-args.ts` prefixes `& ` when a command begins with a quoted token, applied inside `getPowerShellEncodedCommand`. That's the only layer that knows the pane's shell. Guarded so `& 'x'`, `. profile.ps1` and bare `claude …` are untouched.

### 13. Claude's teammate command is POSIX shell *(user-reported)*

**How** — Claude hands the shim `cd '<dir>' && env CLAUDECODE=1 … claude --agent-id …` and the dispatcher passed it straight to the pane's shell. PowerShell 5.1 has no `&&`, and `env K=V cmd` isn't a command there.

**Why it survived** — POSIX panes interpret it correctly. A pre-existing test encoded the exact string and asserted it was forwarded **verbatim** — right on POSIX, wrong everywhere else.

**Fix** — decompose instead of translating, so **no shell syntax is emitted at all**: `cd` becomes a `cwd` option, `env K=V` merges into the existing `env` option, the remainder is a bare command. `cwd` was threaded through the split so a teammate in another worktree starts in the right place.

*Why not translate to PowerShell:* I offered translation as the cheap option and withdrew it — the dispatcher can't see the pane's shell at all, so translating is *more* plumbing, and there's no common syntax to target (`set K=V` vs `$env:K='V'`, `&&` vs `;`).

### 14. The holding pane ran `cat` *(user-reported)*

**How** — Claude splits a placeholder pane running `cat`, then respawns it. On POSIX `cat` holds the pane quietly; in PowerShell it's an alias for `Get-Content`, which blocks prompting `Path[0]:`.

**Fix** — on Windows the placeholder starts as a plain shell. It holds the pane just as well and is replaced moments later anyway.

### 11. `spawn claude ENOENT` *(user-reported)*

**How** — the teammate PATH was `[shimDir, args.baseEnv.PATH].filter(Boolean).join(';')`. A native Windows caller sends `Path`, so `baseEnv.PATH` was `undefined`, `filter(Boolean)` dropped it, and PATH became **one directory**.

**Fix** — new `env-var-casing.ts`. Reads either casing, and writes back *under the caller's own key* — emitting `PATH` when the child already has `Path` leaves two keys with undefined precedence.

```text
before:  caller sends Path  ->  PATH had  1 entry  -> ENOENT
after :  caller sends Path  ->  Path had 60 entries -> resolves
```

### 12. Claude launched but rendered nothing *(user-reported)*

**How** — the Windows launch command ran the CLI **inside Electron-as-node**, which spawns Claude with `stdio: 'inherit'`. Measured in the same pane:

| runtime | `stdout.isTTY` | `stdin.isTTY` |
|---|---|---|
| node | true | **true** |
| electron-as-node | true | **false** |

Claude is an interactive TUI; with non-TTY stdin it can't enter raw-mode input. The process ran 20+ minutes silently.

**Fix** — Windows launch command → `claude --teammate-mode auto`, launched directly by the PTY with a real TTY.

### 5. Batch shim targets couldn't be launched

**How** — `UseShellExecute = false` with a default target of `orca.cmd`. `CreateProcess` cannot execute a batch file, so the whole dev path threw at startup.

**Fix** — batch targets route through `cmd.exe /s /c` with each argument quoted.

### 7. Shim copy re-ran every launch, and would have gone red in CI

**How** — `copyIfChanged` compared size and mtime, but `copyFile` preserves mtime on Windows and **not** on POSIX. The test passed locally and would have failed on the Linux CI that runs the suite.

**Fix** — stamp the target with `utimes` after copying.

### 8. `node:sqlite` blocked packaging entirely

**How** — the packaged-runtime verifier built its allowlist from `builtinModules`, which **omits prefix-only builtins** (`node:sqlite`, `node:test`, `node:sea`) on every Node version. The main bundle legitimately requires `node:sqlite`, so `afterPack` aborted.

**Fix** — also accept `isBuiltin(specifier)`. **This one exists upstream** — the file is byte-identical on `origin/main`, and no Node upgrade fixes it.

### 9. `send-keys` typed key names as text

**How** — only 15 keys were mapped. Arrows, `Home`, `End`, `PPage`/`NPage`, `IC`/`DC`, `BTab` and most chords fell through as **literal text** — `send-keys Left` typed "Left". I hit this directly: my keystroke landed as text in Claude's prompt.

**Fix** — named-key table plus a general chord rule using `charCode & 0x1f`. The intuitive `- 96` is wrong for `C-[` — negative code point. `F1`–`F12` deferred.

---

## Group B — Test defects

Worth dwelling on, because the suite was **green while the feature was completely broken**.

### 4. The load-bearing acceptance test was vacuous

The entire justification for shipping a compiled `.exe` was "Orca must win the `tmux` lookup against a competing port." The test asserted only negatives:

```js
expect(result.stderr).not.toContain('DECOY_WINS')
expect(result.status).not.toBe(99)
```

…with the shim target set to `echo`, which isn't an executable. The shim errored and both assertions passed **on the failure path**. It would have passed for an empty program.

**Fix** — assert a positive: a recording stub must receive `['agent-teams-tmux', '-V']`.

### 3. The integration tests compiled the wrong binary

`buildStubExe` wrote a stub then built with `--target orca`, which compiles `OrcaCliLauncher.cs`. **The stub was never used.** The file's header blamed "needs a full Orca installation" — a misdiagnosis of its own bug, written into a comment.

**Fix** — added `--source <path>` to the build script.

### 2. The shim fabricated a version string to satisfy a test

`OrcaTmuxShim.cs` wrote `tmux 3.4` to stderr **unconditionally on every invocation**, commented *"version sentinel consumed by the build-script integration test."* Production behaviour altered to make a test pass — and a sentinel test would have passed with forwarding entirely broken.

**Fix** — removed. A build test now asserts the binary **doesn't** embed it, replacing one that asserted the opposite.

---

## Group C — Incomplete gating

### 10. A fourth `win32` gate *(user-reported)*

**How** — `tui-agent-config.ts` carried `detectUnsupportedRuntimes: ['win32','wsl']` — a **different mechanism** from the three original gates. Those control the launch plan; this controls whether the agent is *detected at all*, so Settings showed "Available to install" regardless of everything else.

**Why I missed it** — I grepped the renderer for `claudeAgentTeamsMode`, got no hits, and reported "there is no settings UI on any platform." The UI is keyed on the agent id `claude-agent-teams`. Wrong search string, then a negative stated more confidently than the search supported.

**Fix** — `['wsl']`. WSL stays unsupported deliberately: the shim calls back into the host Orca process.

---

## Group D — Implementation slips

### 1. The shim never reached the dispatcher

**How** — the shim passed its target's program name inside the arguments:

```csharp
FileName  = shimBin
Arguments = WindowsCommandLine.Join(shimBin, forwardArgs)   // program repeated
```

`Arguments` must exclude the program. The child got `argv[0] = <path>` while the CLI dispatches on `argv[0]`. **Every forwarded tmux call failed silently.**

**Fix** — `Join("agent-teams-tmux", args)`.

### 6. The dev-build fallback was dead code

**How** — `resolveBundledTmuxShimPath` returned `null` when `resourcesPath` was set but the packaged shim missing. Electron sets `resourcesPath` in dev too, so building the shim locally could never take effect.

**Fix** — try packaged, then dev.

---

## Group E — Deployment

### 16. The daemon never refreshes across same-version builds

This is the one that isn't a Windows bug, and the one that cost the most time.

**Symptom** — fix 15 was correct, present in `out/`, in the installer, and in the installed `app.asar` — and had **no effect across three reinstall cycles**.

**How** — Orca runs PTYs in a separate long-lived daemon, materialised into a directory keyed only on the app version:

```text
%LOCALAPPDATA%\Orca\daemon-host\1.4.148-rc.1\
  .materialized.json  {"version":"1.4.148-rc.1","completedAt":"2026-07-27T09:38:46.922Z", …}
```

```js
const existing = getRelocatedDaemonHost()   // marker.version === app version, files exist
if (existing) return existing               // -> never re-copies
```

No content check. Every build in this effort was stamped `1.4.148-rc.1`, so the daemon host stayed frozen at the 27 July copy:

| | chunk | built | has fix 15 |
|---|---|---|---|
| daemon (in use) | `terminal-output-side-effects-BrBGSYKg.js` | 27/07 17:38 | **false** |
| installed app | `terminal-output-side-effects-Dd33jS70.js` | 28/07 10:20 | true |

The daemon process (PID 22292, started 27/07 21:51:50) survived every reinstall.

**Why every obvious remedy failed, silently**

- *Reinstalling* doesn't touch the daemon host — the marker still matches.
- *Deleting the directory* fails while the daemon holds the `.exe`; the publish step is `rmSync(dest)` then `renameSync`, and the failure is caught and fail-opened, so nothing reports an error.
- *Killing the daemon alone* doesn't help either: on next launch the marker still matches, so materialisation short-circuits before doing any work.

**Which fixes this masked** — only daemon-executed code, which matches the observed history exactly:

| Defect | Layer | Took effect on reinstall? |
|---|---|---|
| 10, 11, 12, 13/14 | main process | yes |
| **15** | **daemon** | **no** |

**Fix** — the marker was removed by hand locally (backup at `%TEMP%\orca-materialized-backup.json`); the daemon still needs stopping so the re-copy can publish. **No code change made.** The proper fix is to key materialisation on a content hash of the daemon sources rather than the version string — but that changes how every Orca installation decides to refresh, too broad to land as a side effect of a Windows bug hunt.

Arguably the more valuable fix is making a failed refresh **observable**: today "couldn't update" is indistinguishable from "already current", so the symptom surfaces far away as a daemon running old code while every artifact check passes.

---

## The question that was open all session — answered

For most of this work I could not make Claude spawn a teammate. It exposes no creation tool to the model and no slash command, and every prompt produced a *subagent*, a different feature. I recorded that the trigger might be unreachable and the whole effort possibly moot.

**It isn't.** Defects 13 and 14 are Claude's *own teammate commands* failing inside panes the shim had already created. Claude invokes it correctly; only the command content was wrong.

The error was specific: repeated failure to trigger the feature through instrumentation was treated as evidence about the feature, when it was evidence about the instrumentation.

## What is verified, and what isn't

Confirmed against the running, installed build:

- installed `app.asar` contains every shipped fix, including the `cwd` override
- `tmux.exe` deployed to the user shim dir with matching size and mtime
- caller sending `Path` yields a 60-entry PATH with `claude.exe` resolvable
- `preflight.detectAgents` returns `claude-agent-teams`
- `orca claude-teams` spawns `claude --teammate-mode auto` — no ENOENT
- the dispatcher drives real panes: `split-window`, `send-keys`, `capture-pane`, `kill-pane`, `respawn-pane`
- **Claude invokes the shim and creates teammate panes**

**Not confirmed:**

- **Defect 15 working.** Implemented, unit-tested, present in the installed app — but never observed running, because defect 16 blocked its deployment for the entire session.
- **A teammate pane rendering and working.** The outcome all of this exists for.
- **A teammate launch on macOS or Linux.** Decomposition now applies there too.

## Deliberately not fixed

- **The same PATH-casing pattern** in `terminal-attribution.ts` and `pty.ts:971/979`. Notably `pty.ts:533` already reads both casings — someone hit this before and fixed it narrowly. The attribution one affects *every* Orca terminal on Windows.
- **Daemon materialisation** (defect 16) — diagnosed and specified, no code change.
- **cmd.exe panes** can't run Claude's single-quoted executable path.
- **`F1`–`F12`** in `send-keys`; **process labelling** shows plain "Claude" on Windows.

## Process notes worth keeping

**Five of these were found by the user, not by me** — 10, 11, 12, 13/14, and 15 — each after I had reported the flow verified.

**Three of my verification methods passed while the system stayed broken**, and each produced confidence that delayed the real diagnosis:

1. Grepping the 115 MB asar *container* for a symbol → reported a present fix as "MISSING". Extraction is the correct method; a hit is trustworthy, a miss is not.
2. Grepping `daemon-entry.js` alone → concluded the daemon lacked the fix, when the code lived in a chunk that entry imports.
3. Verifying the installer, then the installed app, then declaring it fixed → **never checking what the live process was executing.** That is what cost three cycles.

The generalisable rule: **proving a component correct in isolation is not evidence that the user-facing path works.** Verification has to reach the running process.

I was also wrong three times on diagnosis before measurement corrected me — assuming `node-gyp` didn't support VS 2026 (it did; the install had no C++ compiler), that Node 24 would fix the `node:sqlite` check (24.18 omits `sqlite` too), and that shell translation needed no API changes (it needs the pane's shell, which the dispatcher cannot see).

And once, fixing 13/14, I nearly reproduced defect 7 — reading `process.platform` inside the dispatcher, so the test would pass on Windows and fail on Linux CI. It's now a pure parameterised function with both branches asserted.

## Build environment obstacles (not code defects)

1. **No MSVC toolset** — VS Build Tools 2026 installed *without* the C++ workload. Worked around by reusing the ABI-148 `windows-native-registry` binary from the installed app. It lives in `node_modules` and dies on the next `pnpm install`.
2. **Packaging forces a native rebuild** — the `beforeBuild` hook hardcodes `--force`. Temporarily removed per package, reverted after each one.
3. **Disk exhaustion** — two builds died on `ENOSPC`; one truncated a finished 165 MB installer to 64 MB.
4. **`max-lines` hit, not suppressed** — the dispatcher reached 308 against a 300 limit. `AGENTS.md` forbids a disable, so the launch resolver was extracted into its own module.

---

## Reference

- Defects 1–12: `docs/superpowers/specs/2026-07-27-windows-agent-teams-implementation-defects.md`
- Defects 13–14: `docs/superpowers/specs/2026-07-27-teammate-command-shell-decomposition.md`
- Defects 15–16: `docs/superpowers/specs/2026-07-28-powershell-invocation-and-daemon-staleness.md`
- Original design (superseded in scope): `docs/superpowers/specs/2026-07-27-windows-agent-teams-native-panes-design.md`
- OpenSpec: three changes under `docs/openspec/changes/`
