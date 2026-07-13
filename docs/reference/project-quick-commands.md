# Project Quick Commands (orca.yaml)

Share terminal Quick Commands with everyone working on a repository by
committing them to the repo's `orca.yaml`. Implements
[#8481](https://github.com/stablyai/orca/issues/8481).

## Configuration

```yaml
quickCommands:
  - label: Dev server
    command: pnpm dev
  - label: Interactive rebase
    command: 'git rebase -i '
    appendEnter: false # insert without running (right-click Insert mode)
  - label: Investigate
    action: agent-prompt
    agent: claude
    prompt: Investigate the current branch and summarize findings
```

Rules (parsed in `src/shared/orca-yaml.ts`):

- `label` is required. Entries without a body (`command`, or `agent` + `prompt`
  for `action: agent-prompt`) are dropped.
- At most 40 entries are read (same cap as personal quick commands); the
  usual label/command/prompt length caps apply during projection.
- `agent` is kept as a plain string at parse time; clients drop entries whose
  agent does not support launch-time prompts (same rule as personal commands).

## Behavior

- Loading goes through the existing `hooks:check` / `repo.hooksCheck` read
  paths, so local, SSH, and runtime/web repos all work. Results are cached
  per repo in the renderer (`projectQuickCommandsByRepo`) and refreshed in the
  background whenever the tab-bar quick-commands menu opens, so a `git pull`
  that changes `orca.yaml` is picked up without restart.
- Project commands are projected to repo-scoped commands with reserved ids
  (`orca-yaml:<label-slug>`). They are derived data — never persisted into the
  user's settings.
- Union merge with personal commands: the menu shows personal repo commands,
  then a labeled "Project — orca.yaml" section, then global commands. The
  terminal context menu mirrors this. Settings → Quick Commands shows a
  read-only "Project Commands" list.
- Read-only: project commands cannot be edited or deleted from the app.
  "Copy to my commands" duplicates one into personal settings (fresh id) for
  local tweaks. Changing the shared set means editing `orca.yaml` (reviewable
  through normal git workflow).

## Trust

Running (or inserting) a project command is gated by the existing orca.yaml
trust dialog under a dedicated `quickCommands` script kind:

- One SHA-256 hash covers the serialized project command set for the repo;
  first run prompts once, and any `orca.yaml` quick-command change re-prompts.
- "Always trust" for the repo covers project quick commands like other hooks.
- `commandSourcePolicy: local-only` does **not** bypass this prompt — that
  policy governs local overrides of hook scripts, and project quick commands
  have no local variant.

## Edge cases

- Older Orca builds show the "update Orca" hint (`mayNeedUpdate`) for an
  `orca.yaml` containing only `quickCommands` — the key is registered in
  `RECOGNIZED_ORCA_YAML_KEYS`.
- Folder (non-git) repos and floating terminals have no repo context and never
  show project commands.
- Offline SSH/runtime hosts: load failures keep the previous cached snapshot;
  trust checks fail closed (`skip`).
- Duplicate labels get numeric id suffixes; a personal command id colliding
  with a reserved `orca-yaml:` id (hand-edited settings) wins over the project
  command so menu keys stay unique.
