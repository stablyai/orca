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

Status hooks install an Orca-owned native lifecycle plugin in
`$DSH_HOME/cordis.patch.yml`. User entries outside the block are preserved. Local
installation respects `DSH_HOME`; the existing SSH installer uses the execution
host's default `~/.dsh` because SFTP cannot read its environment.

The plugin observes only the root agent. Prompt/tool metadata travels through the
existing managed HTTP hook transport. Readiness uses synchronous OSC 9999 frames
on the existing PTY carrier: `agent/status` running emits working; finalized idle
with no inbox work emits done. Frames require a TTY and Orca pane identity in the environment,
so unrelated SDK/headless output remains untouched. SessionStart is a boundary,
not a completed turn. The Claude-compatible Stop callback runs before finalization
and may steer another step, so legacy Stop remains working. HTTP status stays
identity-only and cannot settle worker readiness after delayed delivery.

Hook upgrades take effect when a new DSH process loads the home patch. Existing
DSH sessions keep their loaded plugin and must not be interrupted to apply this change.
Approval has no dedicated hook and remains governed by Orca's existing visible
prompt arbitration. Descendant agent events never produce parent-pane idle.

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
