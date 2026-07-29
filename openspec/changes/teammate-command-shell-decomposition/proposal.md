## Why

Claude Code hands Orca's tmux shim a POSIX shell string for every teammate pane:

```sh
cd '<dir>' && env CLAUDECODE=1 CLAUDE_… claude --agent-id … --teammate-mode auto
```

The dispatcher passed that verbatim to `splitTerminal`, which runs it in the pane's shell. That works only where the shell is POSIX. On Windows, asking Claude to create an agent team produced two errors from one action:

- `The token '&&' is not a valid statement separator in this version` — PowerShell 5.1 has no `&&`, and `env K=V cmd` is not a command there either.
- `cmdlet Get-Content … Supply values for the following parameters: Path[0]:` — Claude's holding pane runs `cat`, which PowerShell resolves to `Get-Content`, blocking on an interactive prompt instead of sitting quietly.

**This also settled a question that had been open across the whole Windows effort.** Every attempt to trigger a teammate through instrumentation had failed, and the conclusion recorded was that Claude Code might expose no way to create one — making the work possibly moot. These errors prove otherwise: they are Claude's own teammate commands executing inside panes the shim had already created. The trigger works; only the command content was wrong.

## What Changes

- Parse Claude's teammate command into working directory, environment assignments, and the bare command, instead of executing it as shell syntax.
- Pass those through Orca's own spawn options, so no shell syntax is emitted and every pane shell behaves identically.
- Honour an explicit working directory, so a teammate belonging to its own worktree starts there.
- Start the holding pane as a plain shell on Windows rather than running `cat`.
- Leave unrecognised command shapes untouched.

## Capabilities

### New Capabilities

- `claude-agent-teams-teammate-launch`: how a teammate pane's command, environment and working directory are derived from what Claude Code supplies, independent of the pane's shell.

### Modified Capabilities

<!-- None recorded here. See the windows-agent-teams-implementation-defects change for the
     native-panes capability; this covers the launch composition specifically. -->

## Impact

**Code**

- `src/shared/claude-agent-teams-teammate-command.ts` *(new)* — the parser
- `src/main/runtime/claude-agent-teams-teammate-launch.ts` *(new)* — joins parsed output to the pane environment
- `src/main/runtime/claude-agent-teams-tmux-dispatcher.ts` — both split sites use it
- `src/main/runtime/claude-agent-teams-types.ts`, `src/main/runtime/orca-runtime.ts` — `cwd` threaded through `splitTerminal` and `splitPtyBackedTerminal`

**Cross-platform**

Decomposition now applies on every platform, not just Windows. That is deliberate — it removes a latent dependency on the pane shell being POSIX — but it is a behavior change for macOS and Linux, where the string previously executed as shell syntax. Worth exercising there before upstreaming.

**Not addressed**

`agent-process-recognition.ts` still keys on the literal `claude-teams` token, so a directly launched Claude registers as plain "Claude" on Windows. Believed cosmetic; unverified.

**Still unproven**

A teammate appearing as a working Orca pane has not been observed. The parser, launch resolver and `cwd` override are unit-tested and present in the packaged app, but the user-facing outcome is unconfirmed — and two earlier claims in this effort were wrong in exactly that way, with a component proven in isolation while the user path stayed broken.
