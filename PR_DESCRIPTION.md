## Issue

When a multiline prompt (e.g. from a diff annotation or "Send notes to a new agent") was sent to an argv-injected agent like Droid or Codex, the prompt was embedded as a single-quoted argument containing literal newlines. POSIX shells accept literal newlines inside quotes, but the result is a command that spans multiple physical lines in the terminal. The shell only processes the first physical line as the command, and the remaining lines become stray input after the agent has already started. The agent therefore launches **without its prompt argument**, and the leftover lines appear as broken paste input. On Windows, embedded newlines in the prompt were not collapsed, causing similar issues with PowerShell and cmd parsing.

## Summary

Fix multiline agent startup commands for Droid and Codex-style agents by wrapping prompts in `$(printf '%s\n' ...)` command substitution on POSIX shells. This keeps the typed command on one physical line, avoids shell continuation prompts (`quote>`), and still passes the exact multiline value (including real newlines) as a single argv argument.

### Affected Actions

- **Resolve with AI** (diff annotations sent to agent)
- **Annotate and send to AI** (Source Control "Send notes to a new agent" with multiline notes)
- Any flow that launches a new agent terminal with a multiline prompt via `buildAgentStartupPlan()`

### Before

When the prompt contained real newlines, the command was split across physical lines. The agent binary ran without its prompt argument:

```text
droid
^[[200~File: docs/plan.md
Line: 19
User comment: "wdyt about it?\n\nhello btw"^[[201~
```

Droid starts without receiving any prompt — the multiline text is left behind as broken input after the shell processes the first line as the complete command.

### Now

The prompt is wrapped in `$(printf ...)` command substitution, keeping everything on one physical line:

```bash
droid "$(printf '%s\n' 'File: docs/plan.md' 'Line: 19' 'User comment: "wdyt about it?\n\nhello btw"')"
```

Droid starts and receives the full multiline prompt as a single argv argument:

```text
File: docs/plan.md
Line: 19
User comment: "wdyt about it?\n\nhello btw"
```

## Screenshots

No visual change.

## Testing

- [x] `pnpm exec vitest run --config config/vitest.config.ts src/renderer/src/lib/tui-agent-startup.test.ts` — 49/49 passed (22 renderer + 27 shared)
- [x] `pnpm run typecheck` — all three configs pass (node, cli, web)
- [x] `pnpm exec oxlint src/renderer/src/lib/tui-agent-startup.ts src/renderer/src/lib/tui-agent-startup.test.ts src/shared/tui-agent-startup.ts src/shared/tui-agent-startup.test.ts` — 0 warnings, 0 errors
- [x] `pnpm run build:desktop` — typecheck, relay, cli, electron-vite all pass
- [x] `pnpm run build:web` — pass (requires `NODE_OPTIONS=--max-old-space-size=4096` on large codebases)
- [x] `pnpm run build:native` — native macOS computer-use module compiled
- [ ] Manual Orca verification: launch the Orca dev app, trigger a markdown line-comment send-to-agent flow or the Source Control "Send notes to a new agent" action with multiline text, and confirm the new terminal shows one physical line beginning with `droid "$(printf ...` or `codex "$(printf ...`, and the agent receives the full prompt.

## AI Review Report

To be populated after AI review.

## Security Audit

- Input handling: on POSIX, multipart prompt lines are individually shell-quoted with single quotes (replacing `'` with `'\''`) before being wrapped in `$(printf ...)` command substitution. On Windows, embedded newlines are collapsed to spaces.
- No new command execution surface: the existing shell command path is reused; only the quoting strategy changes for multiline prompts.
- Path handling: no paths are constructed from the prompt content.
- The `quoteStartupArg` function uses the same escaping rules that were already present for the single-line case; multiline prompts are split and each line is individually quoted identically.
- No secrets, auth, dependency, or IPC changes.

## Notes

- Depends on `docs/droid-resolve-conflicts-prompt-fix.md`.
- On POSIX shells, single-line prompts keep the simple single-quoted form. Only multiline prompts use the `$(printf ...)` wrapper.
- On Windows, multiline prompts are collapsed to a single space-separated line to stay on one physical line.
- User comment bodies are already formatted by `formatDiffComment()` in `src/renderer/src/lib/diff-comments-format.ts`, which escapes internal newlines as literal `\n` sequences.
- No macOS/Linux/Windows compatibility regression expected; the split is on `\n` detection and the Windows path is gated behind `platform === 'win32'`.
