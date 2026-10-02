# CodeBuddy terminal harness

CodeBuddy uses its own identity in the desktop and mobile agent catalogs, process
detection, telemetry, hooks, resume records and AI Vault. `codebuddy` and `cbc`
identify the interactive CLI; print, server, ACP and detached background modes do
not identify an interactive pane. Model and effort selections use `--model` and
`--effort`; the CLI resolves its stable model aliases for the current account.

Managed hooks use the existing Claude-compatible installer and transport, with
CodeBuddy's own `.codebuddy/settings.json` and hook source. Installation preserves
user hooks and statusline configuration. Local and SSH installers share the same
plan; Windows explicitly selects CodeBuddy's supported PowerShell hook shell.
Status flows through the execution host's canonical hook store.

## Observed lifecycle

Verified with the authenticated CodeBuddy 2.159.0 CLI on macOS:

- `UserPromptSubmit` starts work. `SessionStart` can arrive afterward and must not
  settle that work.
- An unanswered `AskUserQuestion` emits a `Notification` with
  `notification_type: permission_prompt` and the message
  `needs your permission to use AskUserQuestion`.
- In this version, `PreToolUse(AskUserQuestion)` arrives **after** the user answers;
  it resumes working, followed by `PostToolUse` and `Stop`.
- `Stop` supplies the final assistant message and the provider session identity
  supplies the resume command.

The sanitized real event sequence is
`src/shared/__fixtures__/codebuddy-question-hooks.jsonl`. The regression test
replays it through the shared hook listener. Qoder keeps its existing lifecycle
semantics while sharing the common event projection.

AI Vault reads CodeBuddy's `type: message` JSONL records with top-level roles and
`input_text` / `output_text` content blocks. Local, WSL and SSH discovery use the
provider's `.codebuddy/projects` tree and the same incremental parser.

## Validation scope

Live macOS checks exercised launch through Orca's agent menu, model switching,
question waiting, answer submission, working and completion indicators, history
discovery and a resumed session recalling its earlier answer. Hidden-renderer CDP
screenshots record the working, question and completed states. Windows, Linux,
WSL and SSH runtime execution have not been exercised live on this machine.
