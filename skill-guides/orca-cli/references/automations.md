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

Use `--setup run|skip` on create or edit to choose whether each new-per-run worktree runs the repository's setup script; an explicit choice overrides the repository setup policy. Omitted on create, no choice is saved (current Orca skips setup); omitted on edit, the saved choice is kept. `--setup` is refused for existing-workspace automations, including a create with no target run from inside an Orca worktree (pass `--workspace-mode new-per-run` or omit `--setup`), and on hosts whose Orca is too old to keep it. Text output shows the saved choice as `setup: run`, `setup: skip`, or `setup: not set`.

On a plain folder project, `new_per_run` creates separate Orca workspace entries pointing to the same folder. Removing the automation leaves these entries available. To remove one, copy its full `id` from `ORCA worktree list --json`, then run `ORCA worktree rm --worktree "id:<full-instance-id>"`. This removes that entry and stops its sessions without deleting the folder or touching Git. Select by instance ID rather than the shared path; the folder project root cannot be removed with this command.

Use `--extra-agent-args="--model opus --effort high --add-dir docs"` to add arguments after the host's default agent Arguments on every fresh run (always pass it with `=`, since the value starts with `--`). Only model and effort options, plus Claude's `--add-dir`, are accepted, for `antigravity`, `claude`, `codex`, `codebuddy`, `cursor`, `grok`, `omp`, and `pi` (`--model`, `--thinking`). Model or effort in the extras replaces the default's; a default Pi `--provider` stays and scopes the model. Extras can't be combined with `--reuse-session`. `--extra-agent-args=` on edit clears them.

## Safe edits and scheduler cutovers

Before editing, list existing jobs on the relevant hosts and identify which scheduler actually owns each job. Use `ORCA automations show <automationId> --json` before and after an edit to compare the saved prompt, target/workspace mode, `agentId`, available launch settings/arguments, `rrule`, `timezone`, `dtstart`, `nextRunAt`, and `enabled`. JSON includes saved fields omitted from text output; it is not a resolved agent invocation. Check host defaults and run evidence for the effective model/arguments. Trace the saved prompt, any wrapper it calls, and the implementation separately. If an edit times out or returns an uncertain result, inspect the saved state before retrying.

Use returned owner metadata when available, and the source scheduler's supported interfaces, to confirm ownership and enabled state. A paused configuration file or stale copy does not prove the active scheduler stopped. Older or remote hosts may omit ownership or launch details; report those observations as unavailable, and leave a replacement disabled if source ownership or pause cannot be verified. Do not infer remote state from local files.

For migration between schedulers:

1. Back up the source configuration and scheduler state through supported interfaces, including enabled/paused state and run history. Record old-to-new job IDs. Keep originals for rollback; preserve intentionally paused jobs.
2. Stage each replacement with `--disabled`; intentionally paused jobs stay disabled after migration. Preserve the prompt, provider/model arguments, target, workspace/setup/session choices, precheck, schedule and missed-run settings, or record any unsupported difference. Verify runner, tool and credential access on the destination host before cutover.
3. Compare several upcoming execution times in UTC and the intended timezone, including multi-hour cadences and DST boundaries when applicable. Check the actual scheduler host timezone: current Orca occurrence calculations use the scheduler process's local timezone, so a saved `timezone` alone does not establish timing. Do not assume cron/RRULE text translates equivalently or that one matching `nextRunAt` proves the whole schedule. The CLI has no upcoming-occurrences preview command; use supported scheduler observations or offline calculation checked against observed next-run times. Leave the replacement disabled if timing cannot be established.
4. Pause the source through its scheduler's supported interface and read back its actual state before enabling the replacement. For an Orca source, use `ORCA automations edit <oldId> --disabled --json`, then `show <oldId> --json` on the owning host. Disabling does not terminate launched work: inspect pending/running attempts and delegated/background work, and verify they have drained or were explicitly stopped before enabling the replacement with `ORCA automations edit <newId> --enabled --json`. Recheck both schedulers. For rollback, disable the replacement, verify its pause and drain its work, then restore only the source's original enabled state. Keep at most one scheduler enabled throughout; these manual checks provide neither an atomic cutover nor exactly-once execution.

Verify execution separately from configuration. Run a bounded manual attempt only when the user authorized its side effects; **Run now bypasses prechecks even for a disabled job**. Follow its exact run ID in `ORCA automations runs --id <automationId> --json` on the same host/profile to a terminal outcome, then join that attempt to its required output or receipt. A completed launcher is insufficient evidence that a delegated/background workflow finished. Missing downstream output remains unverified; distinguish preview, no-op, fresh collection and delivery. A preview or manual publication no-op does not prove fresh collection, scheduled prechecks or the next scheduled run. Preserve failed attempts and repeat affected checks after prompt, wrapper, implementation or configuration edits.
