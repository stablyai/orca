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

Orca renders agent-authored notes inline beside the diff line they attach to, with an agent
badge and an optional rationale paragraph. You write them from the shell; the human reads
them in Orca's diff pane. There is no interactive TUI — notes are created with the CLI only.

**You are reviewing a changeset, not narrating your own work.** Even when you wrote the
diff, read it back as a reviewer who has to find what the author missed. A note that
explains what the code does has no value: the reader is looking straight at the code.

Resolve the CLI by capability, not by environment: no environment variable reliably names
the build you are talking to, and `diff-note` is absent from older ones. Probe
`orca-dev diff-note --help`, then `orca diff-note --help` (`orca-ide` on Linux outside Orca
terminals), preferring `$ORCA_CLI_COMMAND` when it is set, and use the first that succeeds.
Below, `ORCA` is that executable — substitute it literally, never run `ORCA` as a shell
variable.

If no probe succeeds, stop and tell the user the build lacks diff-note support rather than
improvising. Notes live in the app instance the chosen CLI talks to and are visible only in
that instance's window, so confirm the workspace with `ORCA worktree ps --json` first.

## Workflow

```text
1. Enumerate the changeset:   git diff --stat        (or `git status` for the file list)
2. Read each file's diff:     git diff -- <file>
3. Read outward from it:      grep/read the other call sites that touch the same state
4. Decide what earns a note   (see below; zero notes is a valid answer)
5. Emit every note in one pass:  ORCA diff-note create ...
6. Show the user:             ORCA file diff <path>
7. Verify what you pinned:    ORCA diff-note list --json
```

Step 3 is the one that produces findings worth reading, and it is the step most likely to be
skipped. A diff shows you what changed; it does not show you the code that should have
changed with it. Do not confine the investigation to the lines in the diff.

Notes anchor to the worktree, not to a review session — they persist in Orca's worktree
metadata and stay attached to the line until you `rm` them.

## What earns a note

There is no per-hunk cap: two real findings on adjacent lines are two notes, and the
earlier version of this guide capped hunks at one, which suppressed the better finding.
Write as many notes as clear the bar and not one more. Zero is a correct outcome for a
clean diff, and past about five in a changeset you have lowered the bar rather than found
more.

**The bar: the note must be worth interrupting a developer for.** It earns its place only
if it changes what they do next — verify something, fix something, or make a decision. A
note that leaves the reader with nothing to do is an explanation, and they can already read
the code.

Rejection test — apply it to every candidate note before you write it:

> If a competent reader could work this out from the hunk in front of them, do not write it.

A note must name at least one of:

- a hole in an invariant the change is trying to establish
- a case the change does not handle
- a consequence that lands outside this hunk
- a decision with a live alternative the reader should get to weigh

And it must state a **consequence or a choice** — what breaks, or what the reader has to
decide. A finding with no "so what" is not finished.

### Keep it tight

`--body` is the finding in one line: name the problem, not the code's purpose.

`--rationale` is **two sentences** — one for the consequence, one for the choice. Add at
most one supporting fact, and only when the finding collapses without it. Do not re-quote
identifiers already visible on the line, restate the query the reader is looking at, or
inventory fields and enum members that do not carry the finding. Length is not thoroughness;
the reader is standing in front of the code.

Never write a note that:

- restates what the code does, in prose
- describes your intent as the author
- reassures the reader that the change is safe
- explains language or library semantics the reader already knows

### Example

The diff adds a publish gate requiring at least one photo:

```ts
if (published === true) {
  const photoCount = await prisma.photo.count({ where: { postId: id } })
  if (photoCount === 0) throw new AppError(400, 'A post needs at least one photo…')
}
```

Rejected — restates the code and reassures:

> `--body "Publish gate: a post must have ≥1 photo to go live"`
> `--rationale "Server-side product rule. Only the draft→published transition is gated; throws a 400 AppError."`

Worth pinning — found by reading outward, names the gap and the choice:

> `--body "Gate is transition-only; DELETE /posts/:id/photos/:photoId has no symmetric guard"`
> `--rationale "A published post can still be driven to zero photos, so the invariant only holds at the publish moment. Either gate photo deletion on published posts or accept the gap explicitly."`

> `--body "Counts every Photo row regardless of status"`
> `--rationale "A post can go live while its only photo is still processing or has failed, so the gate passes with zero viewable images. Filter status:ready if the intent is a viewable photo at publish time."`

Both notes sit in the same hunk, and both belong. The second one's supporting fact is the
status set; naming the null URL columns as well would add length without adding the finding.

## Commands

```bash
ORCA diff-note create <path> --line <n> --body "<finding>" [--rationale "<consequence + choice>"] [--author <name>] [--worktree <selector>] --json
ORCA diff-note list [--path <file>] [--worktree <selector>] --json
ORCA diff-note rm --id <noteId> [--worktree <selector>] --json
```

- `<path>` is the worktree-relative file path (first positional, or `--path`).
- `--line` is the 1-based line number on the **modified (right-hand) side** of the diff.
- `--body` is the finding in one line — not the code's purpose.
- `--rationale` is two sentences: the consequence, then the choice it forces. It is not a
  justification and not a safety argument.
- `--author` labels the note header (e.g. agent/model name); default is just "Agent".
- `--scope unstaged|staged|branch` records which diff view the note came from (default unstaged).
- `--worktree` defaults to the current Orca-managed worktree inferred from cwd. Pass
  `path:<abs-worktree-path>` or `id:<repoId>::<path>` when cwd is not the worktree.
- `rm` uses the note id from `diff-note list --json` (`result.comments[].id`).

## Finding the line number

`--line` is the modified-side line number in the file as it exists now, 1-based. Anchor to
the line the finding is about. For a finding that spans a hunk, use the first line of the
hunk. When the finding is about code *outside* the diff, anchor it to the changed line that
creates the problem — that is where the reader needs to see it.

## Guiding a review

Work in the order that tells the clearest story, not necessarily file order. Lead with the
finding that would change the reader's decision, and stop when you run out of findings
rather than when you run out of hunks.

## Common errors

- "No Orca-managed worktree contains the current directory" — pass `--worktree path:<abs-worktree-path>`.
- "Missing required --line" — every note needs a 1-based modified-side line number.
- "selector_not_found" — the worktree isn't registered in the running Orca; confirm with `ORCA worktree ps --json`.
