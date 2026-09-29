# Sketch: surface "needs a reply" on the PR review icon

## What we found in the real source that changes the plan

The original plan was a generic `--needs-attention` CLI hook, external to any
GitHub-specific logic. Cloning `stablyai/orca` and reading the actual code
shows most of the pieces already exist natively:

- `src/shared/hosted-review.ts` — `HostedReviewInfo` already carries
  `reviewDecision?: PRReviewDecision | null`. Real, already-fetched data.
- `src/shared/hosted-review-github.ts` — already has `unresolvedThreadCount()`
  and a `reviewDecision` mapping (`'CHANGES_REQUESTED' → 'changes_requested'`)
  feeding a **different, unrendered** type (`HostedReviewQueueSummary`,
  presumably for a planned reviewer-inbox feature — zero renderer usage found).
- `src/renderer/src/components/sidebar/WorktreeCardStatusSlot.tsx` — the real
  sidebar row component. It already has a **dedicated PR-review icon slot**
  (`ReviewIcon` / `getReviewLabel` / `WorktreeCardPrDisplay`), separate from
  the agent-status `StatusIndicator` (the bell). Exactly the "own lane, not
  conflated with agent status" property we wanted — it already exists.
- `src/renderer/src/components/github-pr-merge-state.ts` — already branches
  on raw `reviewDecision === 'CHANGES_REQUESTED'` for a merge-button warning
  ("GitHub reports requested changes on this pull request") — this is the
  **naive version with our exact bug**: no check for whether the author has
  replied since. Confirmed by reading it directly.

So: no new CLI flag, no new hook, no new data model field. `reviewDecision`
is already there. What's missing is (a) the "have you responded since"
refinement we already built for our own tool, and (b) wiring a result into
the one rendering surface that currently only shows `state`/checks status,
not `reviewDecision` at all — `WorktreeCardStatusSlot.tsx`'s `getReviewStatusTooltip`
(lines 66–87) never looks at `reviewDecision`.

## Design

**New derived concept, computed where `HostedReviewInfo` is assembled**
(`hostedReviewInfoFromGitHubPRInfo` in `hosted-review-github.ts`): a boolean
`needsReply` (name TBD), true when:

```
reviewDecision === 'CHANGES_REQUESTED'
  AND no comment/review from the PR author exists after the most recent
      CHANGES_REQUESTED review's submittedAt
```

This is exactly `changes_requested_still_pending()` from our own
`orca-pr-watch.py`, ported to wherever `PRInfo`/comments are already fetched
for GitHub PRs (this repo already fetches comments — see `PRComment[]` used
by `unresolvedThreadCount`). Reuse `unresolvedThreadCount`'s existing
thread-walk for the "unresolved, last-comment-not-yours" half of the
condition — don't reinvent it, it's already 90% there, just not
author-aware yet.

**Rendering**: extend `getReviewStatusTooltip` (`WorktreeCardStatusSlot.tsx`)
with a case ahead of the existing merged/closed/draft/checks branches:

```ts
if (review.needsReply) {
  return `${label}: Changes requested — reply needed`
}
```

And give `ReviewIcon` (`worktree-review-helpers.tsx`) a distinct visual for
it — reusing whatever warning/amber token `#4893` introduced
(`--status-warning`), on the *existing PR icon glyph*, not a new one. This
keeps it in the PR-review lane, physically separate from the agent-status
bell in `StatusIndicator.tsx` — the same separation of concerns the user
wanted, but for free, because that lane already exists.

## Known limitation to flag in the PR description, not hide

`canShowReviewStatus` (`WorktreeCardStatusSlot.tsx` line ~105) only shows the
PR icon when `QUIET_REVIEW_REPLACEABLE_STATUSES` (`active`/`done`/`inactive`)
— i.e. it's currently hidden whenever an agent is actively working or
waiting in that worktree, same as it is today for a plain "Open" PR. So a
freshly-changes-requested PR wouldn't visually surface until the agent goes
quiet. Worth naming this explicitly as an accepted v1 limitation (matches
existing precedent for the same icon) rather than solving it — expanding
`needsReply` to override the quiet-only gating is a reasonable v2 if wanted,
but it's a separate, more invasive change (touches priority/z-order logic
across `StatusIndicator` and `WorktreeCardStatusSlot` together).

## Scope for a first PR

- GitHub only (matches what's already implemented for `reviewDecision`/
  `unresolvedThreadCount` today — GitLab/Bitbucket/Azure DevOps/Gitea don't
  have either yet, so extending to them is out of scope, not a regression).
- No new settings/toggle — reuses existing review-icon visibility rules.
- No new CLI surface at all, which simplifies review a lot — this is now a
  pure data-plumbing + rendering change, not a new public API to design,
  document, and commit to stability for.
- Test plan: extend `worktree-card-pr-display.test.ts` and
  `WorktreeCardStatusSlot.test.tsx` (both already exist) with a
  changes-requested-but-replied-to fixture (should NOT show the warning) and
  a changes-requested-not-yet-replied-to fixture (should show it) — directly
  modeled on the real PR #996 case that motivated this.

## Net effect on our own tool

If this lands, `orca-pr-watch.py`'s entire `check_pr`/GraphQL/cron
apparatus becomes redundant for anything Orca-native-GitHub — the sidebar
would show it live, natively, with no 5-minute polling lag and no fake
agent-hook trick. The tool would still matter for: non-GitHub providers (no
native support yet), and the "waiting" agent-style indicator specifically if
that's still wanted for other reasons. Worth deciding later whether to
deprecate `orca-pr-watch.py` once/if this merges, or keep it as a stopgap
for providers this PR doesn't cover.
