## 1. Parse Claude's teammate command

Files: `src/shared/claude-agent-teams-teammate-command.ts` *(new)* and its test.

- [x] 1.1 Add `parseTeammateCommand(raw, platform?)` returning `{ cwd?, env, command }`, recognising the `cd <dir> && env K=V … <command>` shape Claude emits.
- [x] 1.2 Tokenize with quote awareness and record offsets, then slice the command out of the original string — rejoining tokens would drop quotes and split an argument containing spaces.
- [x] 1.3 Stop consuming environment assignments at the first token that is not a valid `NAME=value`, so a long option written with `=` stays part of the command.
- [x] 1.4 Strip quotes from a directory containing spaces.
- [x] 1.5 Pass unrecognised shapes through untouched, so only what Claude actually emits is reinterpreted.
- [x] 1.6 Drop the `cat` placeholder on Windows only, taking platform as a parameter rather than reading `process.platform`, so both branches are assertable on any host.
- [x] 1.7 Cover: full prefix, cd-only, env-only, no prefix, quoted Windows path, quoted env value, quoted command argument, assignment-lookalike option, empty remainder, extra whitespace, and the placeholder on win32 / darwin / linux.

## 2. Resolve a teammate launch

Files: `src/main/runtime/claude-agent-teams-teammate-launch.ts` *(new)*.

- [x] 2.1 Add `resolveTeammateLaunch(rawCommand, team, fakePaneId)` returning `{ command, cwd, env }`, merging the parsed environment over the pane environment.
- [x] 2.2 Return an undefined command for an empty or placeholder input, so the pane opens as a bare shell.
- [x] 2.3 Keep this in its own module rather than inline — the dispatcher crossed the 300-line limit and repository rules forbid a `max-lines` disable.

## 3. Thread a working directory through the split

Files: `src/main/runtime/claude-agent-teams-types.ts`, `src/main/runtime/orca-runtime.ts`.

- [x] 3.1 Add an optional `cwd` to `AgentTeamsTerminalApi.splitTerminal`.
- [x] 3.2 Add it to `OrcaRuntime.splitTerminal` and `splitPtyBackedTerminal`.
- [x] 3.3 Use `opts.cwd ?? workspace.path` at the spawn call, which already accepted a cwd.

## 4. Use it from both dispatcher split sites

Files: `src/main/runtime/claude-agent-teams-tmux-dispatcher.ts` and the service test.

- [x] 4.1 Use the resolver in `split-window`, passing command, cwd and env; fall back to the tmux `-c` start-directory when Claude supplied none.
- [x] 4.2 Do the same in `respawn-pane`, which is where the real teammate command actually arrives.
- [x] 4.3 Remove the now-orphaned `paneEnv` import from the dispatcher.
- [x] 4.4 Update the service test, which asserted the POSIX string was forwarded verbatim, to assert decomposition instead — and derive the placeholder expectation from the platform rather than hard-coding one host's answer.

## 5. Verification

- [x] 5.1 Unit tests green: parser, service, shim env, tmux compat, env casing, detection, startup plan.
- [x] 5.2 `typecheck:node` clean.
- [x] 5.3 `oxlint` clean on the touched files, and the repository max-lines ratchet reports no new bypasses.
- [x] 5.4 Confirm all fixes are present in the packaged `app.asar`, including the `cwd` override — not just in the build output.
- [ ] 5.5 Observe a teammate opening as a working Orca pane, in the correct directory, with no PowerShell parse error and no `Get-Content` prompt. **Not done.** This is the outcome the change exists for; everything above is necessary but not sufficient evidence.
- [ ] 5.6 Exercise a teammate launch on macOS or Linux, since decomposition now applies there too and previously the string was interpreted by the shell.

## 6. Follow-ups not in this change

- [ ] 6.1 Teach `agent-process-recognition.ts` to match `claude --teammate-mode auto` so Windows stops labelling the agent plain "Claude".
- [ ] 6.2 Revisit the parser if Claude Code changes how it composes the command — a pipeline, a second `&&`, or a shell function would fall through to passthrough and fail on Windows exactly as before.
- [ ] 6.3 `F1`–`F12` remain unmapped in `send-keys`.
