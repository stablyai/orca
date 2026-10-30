# Automations

An automation is a scheduled Orca prompt run by a chosen provider against either a repo-created worktree or an existing workspace.

```text
ORCA automations list --json
ORCA automations show <automationId> --json
ORCA automations create --name "Daily review" --trigger daily --time 09:00 --prompt "Review open changes" --provider codex --repo id:<repoId> --json
ORCA automations create --name "Weekday triage" --trigger "0 9 * * 1-5" --prompt "Triage issues" --provider claude --repo path:/abs/repo --disabled --json
ORCA automations create --name "Inbox digest" --trigger hourly --prompt "Summarize unread mail" --provider codex --workspace active --reuse-session --json
ORCA automations edit <automationId> --trigger weekdays --time 09:30 --fresh-session --json
ORCA automations run <automationId> --json
ORCA automations runs --id <automationId> --json
ORCA automations remove <automationId> --json
```

Schedules accept `hourly`, `daily`, `weekdays`, `weekly`, 5-field cron, or RRULE. Use `--time <HH:MM>` with `daily`/`weekdays`/`weekly`, and `--day <0-6>` only with `weekly` where Sunday is `0`.

Use `--precheck <command>` to run a shell command only before scheduled runs. Exit code `0` continues; any other exit, error, or timeout skips the run. Set the time limit with `--precheck-timeout <seconds>` (default `60`). Skips appear in Orca run history and `ORCA automations runs --id <automationId> --json` with status `skipped_precheck`.

**Run now** in Orca and `ORCA automations run <automationId>` intentionally bypass the precheck, so you can test the automation or override its scheduled condition.

Use `--repo <selector>` for a new worktree per run, or `--workspace <selector>` / `--workspace-mode existing` for an existing Orca worktree. `--repo` and `--workspace` are mutually exclusive. Use `--reuse-session` only for existing-workspace automations; if the previous terminal is gone, Orca falls back to a fresh session. Prefer `--disabled` while testing setup.

On a plain folder project, `new_per_run` creates separate Orca workspace entries pointing to the same folder. Removing the automation leaves these entries available. To remove one, copy its full `id` from `ORCA worktree list --json`, then run `ORCA worktree rm --worktree "id:<full-instance-id>"`. This removes that entry and stops its sessions without deleting the folder or touching Git. Select by instance ID rather than the shared path; the folder project root cannot be removed with this command.

Use `--extra-agent-args="--model opus --effort high --add-dir docs"` to add arguments after the host's default agent Arguments on every fresh run (always pass it with `=`, since the value starts with `--`). Only model and effort options, plus Claude's `--add-dir`, are accepted, for `claude`, `codex`, `codebuddy`, `cursor`, `grok`, and `omp`. Model or effort in the extras replaces the default's. Extras can't be combined with `--reuse-session`. `--extra-agent-args=` on edit clears them.
