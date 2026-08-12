## Context

Orca impersonates tmux for Claude Agent Teams. Claude's pane backend calls `split-window` to create a holding pane, then `respawn-pane -k` to replace it with the real teammate command. Both arrive at `ClaudeAgentTeamsTmuxDispatcher`, which forwarded the command string straight into `api.splitTerminal` as `command`.

That string is POSIX shell:

```sh
cd '<dir>' && env CLAUDECODE=1 CLAUDE_… claude --agent-id … --teammate-mode auto
```

On macOS and Linux the pane's shell interprets it correctly, so the design held. On Windows the pane shell is PowerShell, which has no `&&` in 5.1, no `env` command, and resolves the placeholder `cat` to `Get-Content` — which blocks prompting for a path.

A pre-existing test encoded the exact string and asserted it was forwarded *verbatim*. That assertion was correct on POSIX and wrong everywhere else; it is why the defect was invisible.

**This bug also resolved the effort's biggest open question.** Repeated attempts to trigger a teammate had failed, and the recorded conclusion was that Claude Code might expose no way to create one. The user's error messages disproved that: they are teammate commands executing inside panes the shim had already created. Instrumentation failure had been mistaken for absence of the feature.

| Claim | Evidence |
|---|---|
| Claude invokes the shim and creates panes on Windows | **verified** — errors originate inside shim-created panes |
| Claude emits `cd … && env … <cmd>` | **verified** — in the error text and a pre-existing test |
| Nothing translated it for Windows | source-read — no translation exists anywhere |
| `cat` resolves to `Get-Content` and prompts | **verified** — the `Path[0]:` prompt is that cmdlet |
| PowerShell 5.1 rejects `&&` | **verified** — the parser error names it |
| The dispatcher cannot see the pane's shell | source-read — no `shellPath` in `orca-runtime.ts` |
| `splitPtyBackedTerminal` already passes a cwd to spawn | source-read |
| Decomposition fixes the end-to-end failure | **inferred** — unit-tested and packaged, not yet observed |

## Goals / Non-Goals

**Goals**

- A teammate pane launches correctly whatever shell the pane runs.
- A teammate belonging to another worktree starts in that worktree.
- The placeholder pane never blocks on a prompt.
- Unknown command shapes keep today's behavior.

**Non-Goals**

- Translating shell syntax per shell family.
- Teaching process recognition about directly launched Claude.
- Any change to how Claude Code composes the string.

## Decisions

**Decompose rather than translate.** Translation was the initially chosen route and had to be withdrawn: it requires knowing the pane's shell, which the dispatcher cannot see — the shell is resolved in the daemon PTY layer, so surfacing it is *more* plumbing than adding a `cwd` option, and the result is a translator that must be independently correct for PowerShell, cmd and Git Bash. There is also no common syntax to target: `set K=V` versus `$env:K='V'`, and `&&` versus `;`, cannot be reconciled, and wrapping the whole thing in `cmd /c "…"` only relocates the quoting problem to whichever shell parses that line.

Decomposition is categorically different rather than a weaker version of the same idea: it emits no shell syntax at all. A bare `claude --agent-id x --teammate-mode auto`, with environment supplied out of band, runs identically under every shell.

**Honour cwd properly instead of dropping a redundant clause.** The simpler option was to discard the `cd` when it matched the inherited directory, which it does in the observed case. Rejected because a teammate may legitimately belong to another worktree, and silently starting an agent in the wrong repository is a damaging failure rather than a cosmetic one. The cost was small: `splitPtyBackedTerminal` already passed `cwd` to `ptyController.spawn`, so this is an override at one call site plus an optional field on two type definitions.

**Slice the original text for the command.** Rejoining parsed tokens would drop quotes and turn one argument into several — a prompt containing spaces is the obvious casualty. The tokenizer records offsets so the command can be sliced out of the original string untouched.

**Make the placeholder rule pure and platform-parameterised.** The first implementation read `process.platform` inside the dispatcher, which made its test pass on Windows and fail on Linux CI — precisely the trap that an earlier defect in this effort had already sprung. Passing platform as a parameter lets both branches be asserted on any host.

**Apply decomposition on all platforms, not just Windows.** A win32-only branch would leave POSIX depending on shell interpretation that happens to work. One code path is easier to reason about and removes the latent quoting dependency, at the cost of a behavior change on macOS and Linux that should be exercised there.

**Extract rather than suppress on the line limit.** The dispatcher crossed the 300-line limit at 308. Repository rules forbid adding a `max-lines` disable, so the launch resolver moved into its own module.

## Risks / Trade-offs

**The end-to-end outcome is unconfirmed.** Everything here is unit-tested and verified present in the packaged application, but no teammate pane has been observed. Two earlier claims in this effort were wrong in exactly this shape — a component proven in isolation while the user-facing path remained broken — so this should not be treated as complete until a teammate pane is seen working.

**POSIX behavior changed.** macOS and Linux previously executed the string as shell syntax and now receive a decomposed launch. The intent is that this is equivalent-or-better, but it is untested on those platforms.

**Parser coverage is bounded by observation.** Only the shapes Claude has been seen to emit are recognised; anything else passes through. If Claude adds a construct — a second `&&`, a pipeline, a shell function — it will fall back to the old behavior and fail the same way on Windows. Unknown-shape passthrough is deliberate, but it means the parser needs revisiting if upstream changes its command composition.

**Process label.** A directly launched Claude registers as plain "Claude" because recognition matches the `claude-teams` token. Believed display-only, unverified, and cheap to fix separately.
