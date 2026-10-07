# DeepSeek Harness integration

Orca detects the community `@deepseek-harness-tui/dsh-tui` launcher (`dsh-tui`, alias
`dst`) and requires the official `@deepseek-ai/dsh` executable too. The launcher
boots the `dsh-tui` profile; Orca passes `.` to select the current workspace and
reach its composer on the first launch. The official Harness does not bundle this community TUI.
DSH Console and DeepSeek Build are separate products and are not interchangeable
with this launch contract.

The official DSH 0.2 CLI accepts both `dsh --profile headless` and `dsh headless`.
Orca excludes the known `web`, `headless`, `sdk`, `sdk-minimal`, `acp`, and `desktop`
profiles from interactive process recognition, along with plugin management and
configuration dumps. Custom profile names remain eligible because profiles are
user configurable. Only launcher arguments are inspected; app prompts, resume IDs,
and patch filenames cannot change the selected profile's identity.

Status hooks use the official `@deepseek-ai/dsh-hooks-claude-code` plugin, installed
as an owned block in `$DSH_HOME/cordis.patch.yml`. User entries outside the block are
preserved. Local installation respects `DSH_HOME`; the existing SSH installer uses
the execution host's default `~/.dsh` because SFTP cannot read its environment.
Hooks report session start, prompt submission, tool start/end, and stopping through
Orca's host status store. Startup, resume, and clear are idle session boundaries,
not completed turns, so they do not trigger completion notifications. Compact and
unknown session-start sources leave the ongoing turn untouched. Approval has no
dedicated hook; it is not inferred from an uncaptured screen.

Subagent lifecycle events are ignored for parent-pane status. The 0.2.0-rc.2 bridge
also emits ordinary session, prompt, tool, and Stop hooks for children. Those hooks
carry the child's `session_id`, but no parent identity; their startup/resume sources
are identical to the lead's. Child SessionStart no longer triggers completion, but
ordinary child hooks can still overwrite the lead row. Safe admission needs ordered
root/child provenance from the producer, not a guessed session-id replacement rule.

DSH 0.2 still emits an empty `transcript_path` in Claude-compatible hooks. Its
session persistence defaults to compressed JSONL under `$DSH_HOME/sessions`.
Orca can resume a hook-associated session through `dsh-tui --resume <id>`, but
currently does not discover DSH logs in Agent Session History. Resume support alone
does not establish transcript-history support.

## Reproduce the official launcher check

Install `@deepseek-ai/dsh@0.2.0-rc.2` into a disposable prefix, then run:

```sh
ORCA_BACKGROUND_LAUNCH=1 ORCA_REAL_DSH_CLI=/path/to/prefix/node_modules/.bin/dsh \
  pnpm test src/shared/dsh-real-cli.test.ts
```

The opt-in test checks published version, composed profile configurations, and
headless help in an isolated home and working folder without a model request.
Interactive readiness is separately pinned to the captured community TUI transcript
in `src/main/runtime/__fixtures__/dsh-tui-ready-no-key.txt`; that older capture is
not proof of current TUI compatibility or paid generation.
