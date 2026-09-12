---
name: orca-diff-notes
description: >-
  Pin agent-authored review findings to specific diff lines in an Orca-managed worktree so
  they render inline beside the code in Orca's diff pane. Use when the user asks for review
  notes or annotations on a changeset, says "add diff notes", "annotate this change",
  "leave rationale on the diff", "review this diff", "explain the change line by line", or
  wants you to walk them through a diff. Distinct from human review notes, which Orca
  renders without the agent badge.
---

# Orca Diff Notes

This file is a discovery stub, not the usage guide. The full, version-matched guide is
served by the Orca binary itself — kept out of this file so it can never drift from the
binary that will actually run your commands.

Pin agent-authored review findings to specific diff lines in an Orca-managed worktree. Use
when the user asks for review notes or annotations on a changeset, says "add diff notes",
"annotate this change", "leave rationale on the diff", "review this diff", or wants you to
walk them through a diff.

## Non-negotiables

These hold even before you load the full guide:

- **You are reviewing, not narrating.** A note that explains what the code does is worthless
  — the reader is looking straight at the code.
- **No cap per hunk.** Two real findings on adjacent lines are two notes. Write as many as
  clear the bar below and not one more; zero is a valid answer for a clean diff. If you are
  past about five in a changeset, you have lowered the bar, not found more.
- **The bar:** the note must be worth interrupting a developer for. It earns its place only
  if it changes what they do next — verify something, fix something, or make a decision.
- **Rejection test:** if a competent reader could work it out from the hunk in front of
  them, do not write it.
- **Read outward before writing.** A diff shows what changed, not the code that should have
  changed with it. The findings worth reading come from the call sites the diff *didn't*
  touch.
- **Every note names a consequence or a choice** — what breaks, or what the reader has to
  decide. Never restate the code, describe your intent, or argue that the change is safe.
- **Keep the rationale to two sentences.** One for the consequence, one for the choice. Add
  at most one supporting fact, and only if the finding collapses without it. Do not re-quote
  identifiers already visible on the line or inventory fields the reader can see.

## Resolve the CLI by capability, not by environment

`diff-note` does not exist in every Orca build, and no environment variable reliably tells
you which build you are talking to. Probe instead. Run these in order and use the first
that succeeds:

```bash
orca-dev diff-note --help    # dev build from an Orca checkout
orca diff-note --help        # released build (on Linux outside Orca terminals: orca-ide)
```

If `ORCA_CLI_COMMAND` is set, probe that value first. Below, `ORCA` is whichever probe
succeeded — substitute it literally, never run `ORCA` as a shell variable.

If every probe answers `Unknown command: diff-note`, **stop and tell the user** their Orca
build has no diff-note support: from an Orca checkout they need `pnpm build:cli` and a dev
app instance. Do not improvise another way to leave notes, and do not fall back to a build
whose help output lacks the command.

Notes are stored by the app instance your chosen CLI talks to, so they are only visible in
that instance's window. Confirm the target workspace is registered there before writing:

```bash
ORCA worktree ps --json
```

## Load the full guide before pinning notes

```text
ORCA skills get orca-diff-notes
```

Read it first — it carries the worked example of a rejected note versus a note worth
pinning. Then pin notes with `ORCA diff-note create`. Don't guess subcommands or flags from
memory; they change between Orca releases. Prefer `--json` for agent-driven calls.

If `skills get` answers `Unknown skill topic`, you resolved a CLI older than this skill.
Re-run the capability probe above; if the CLI that has `diff-note` still cannot serve the
guide, work from the non-negotiables above and `ORCA diff-note create --help`.
