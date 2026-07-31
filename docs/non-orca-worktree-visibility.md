# Non-Orca Worktree Visibility

How Orca decides whether a worktree it did not create appears in the sidebar, and which surface
can change that decision. Builds on the analysis in #10560 (agent scratch needs an opt-in) and
#11275 (a hidden worktree needs a per-path way back).

## Two kinds, by path only

A worktree Orca did not create is classified by where it lives, never by content:

- **Agent scratch worktrees** (`agent-scratch`): `<repo>/.claude/worktrees/**` or
  `<repo>/.gsd-workspaces/**`. Agent plumbing, created by sub-agent fan-out.
- **Other worktrees** (`external`, or `unknown-legacy` on repos predating the rollout):
  anything else, typically a hand-made `git worktree add`.

`AGENT_SCRATCH_PATH_PREFIXES` is a moving target: agent CLIs relocate their scratch directories
on their own schedule. A location the list misses floods the sidebar; a location it covers
disappears. Curation alone cannot resolve that tension, so both kinds need a visible switch and
a per-worktree override.

## Two levers per kind, and one guarantee

Each kind has its own repo setting, both defaulting to hidden for new repos:

| Kind             | Setting                      | Applies to worktrees created later |
| ---------------- | ---------------------------- | ---------------------------------- |
| Agent scratch    | `agentWorktreeVisibility`    | Yes                                |
| Other worktrees  | `externalWorktreeVisibility` | Yes                                |

The #9388 guarantee is unchanged and now pinned by a test: `externalWorktreeVisibility` can
never reveal an agent worktree, whatever its value. Agent worktrees answer only to their own
setting, an explicit import, or being the selected checkout.

`importedExternalWorktreePaths` records per-path exceptions and is checked **before** either
setting in `shouldShowWorktree`, so an exception outranks the switch. Two consequences the UI
has to honor:

1. Hiding a whole kind also drops that kind's exceptions, otherwise rows would survive the
   switch that was just set.
2. A row is an exception when the rule **without** imports would hide it, not when its path
   happens to sit in the list. The path list can lag behind reality; the rule cannot.

`externalWorktreeInboxBaselinePaths` is a notification ledger, not a visibility input. It only
means "the user already decided about this path, stop asking". Recovery surfaces must ignore
it, or keeping a worktree hidden once would make it unrecoverable.

## Surfaces

- **`Non-Orca worktrees` dialog** (project actions menu): the permanent home. One section per
  kind, each with its setting and a collapsible per-worktree list to show or hide one at a
  time. It refetches authoritatively on open; when that fails it says so and offers a retry,
  and the bulk switches stay disabled, because hiding a kind purges that kind's imports and
  writes its decision ledger from the very list that could not be read.
- **`New externally-created worktrees` inbox** (sidebar): notification only, for paths with no
  decision yet. Its own actions write the baseline; it points at the dialog for anything else.
- **`Hiding N discovered worktrees`** (sidebar): the first-run question for the other kind on a
  repo that has never answered. It retires permanently once answered.

## Invariant

Every worktree `git worktree list` reports is either unconditionally visible or accounted for
by exactly one kind's selectors. Unconditionally visible means the selected checkout,
`orca-managed`, an explicit exception, or an `unknown-legacy` row on a legacy repo, which
`shouldShowWorktree` keeps visible whatever the setting. That last case is why the sections
count only what their own switch can move: a section must never report a state its button
cannot produce, nor offer a "Hide all" that hides nothing. A dropped worktree is a bug; the
shared tests in `worktree-ownership.test.ts` and
`non-orca-worktree-visibility-candidates.test.ts` cover the boundaries.

## Non-goals

- Changing either default. Both kinds stay hidden for new repos.
- Changing `AGENT_SCRATCH_PATH_PREFIXES`. Adding a location silently hides worktrees that are
  visible today, which is the regression this design exists to make recoverable.
- Pruning `importedExternalWorktreePaths` when a worktree disappears from disk. A recreated
  path stays visible on purpose; revisit if that surprises users.
