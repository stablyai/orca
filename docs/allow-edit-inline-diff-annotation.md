# Allow Edit Inline Diff Annotation

## Problem

Saved inline notes render inside Monaco view zones, not normal React layout. The edit UI already exists, but current E2E coverage only verifies delete. A regression in view-zone pointer routing, edit-mode lifecycle, submit semantics, or in-place zone re-render would ship undetected.

Relevant code:

- [src/renderer/src/components/diff-comments/DiffCommentCard.tsx](/Users/jinjingliang/Documents/projects/orca/allow-edit-inline-diff-annotation/src/renderer/src/components/diff-comments/DiffCommentCard.tsx:24): edit button, textarea, Save/Cancel, Enter-to-save (Shift+Enter newline), Escape cancel, keeps editor open on failed submit.
- [src/renderer/src/components/diff-comments/useDiffCommentDecorator.tsx](/Users/jinjingliang/Documents/projects/orca/allow-edit-inline-diff-annotation/src/renderer/src/components/diff-comments/useDiffCommentDecorator.tsx:24): renders cards into Monaco view zones, enables `onUpdateComment` only where provided, re-renders existing zone roots when body changes, and resizes zones on content growth.
- [src/renderer/src/store/slices/diffComments.ts](/Users/jinjingliang/Documents/projects/orca/allow-edit-inline-diff-annotation/src/renderer/src/store/slices/diffComments.ts:225): optimistic `updateDiffComment`, trim + empty rejection, unchanged-body no-op success, missing-id failure, per-worktree serialized persist queue, rollback on persist failure.
- [tests/e2e/diff-note-delete.spec.ts](/Users/jinjingliang/Documents/projects/orca/allow-edit-inline-diff-annotation/tests/e2e/diff-note-delete.spec.ts:1): existing pattern for seeding via `window.__store` and exercising view-zone card interactivity.

## Goal

Add E2E regression coverage that proves editing a saved inline note inside a Monaco view zone works end-to-end:

1. UI enters edit mode from the inline card.
2. Save routes through decorator callback to `updateDiffComment` and persists via the existing slice path.
3. Store reflects the edited body for the same note id.
4. Inline card content updates in the already-open Monaco zone without reopening the diff tab.

## Non-goals

- No UI redesign or copy changes.
- No schema changes to `DiffComment`.
- No remote PR-review-note editing behavior changes.
- No hover-to-add coverage in this test.

## Test Design

1. Reuse the setup pattern from delete E2E: wait for active worktree/session, modify a tracked file to guarantee a visible diff, seed one note via `window.__store`, then open that file diff tab.
2. Target `.orca-diff-comment-edit` in the view zone, click it, type edited text in `.orca-diff-comment-popover-textarea`, click `Save`.
3. Assert store state by polling `window.__store` for the same comment id and new body (persist is async).
4. Assert edit controls close (`.orca-diff-comment-popover-textarea` absent) and body view returns.
5. Assert rendered inline body equals edited text for the card and does not still show the seeded body.
6. Keep path handling platform-neutral (derive separator from worktree path as existing E2E does).

## Required Assertions

- Save is disabled for unchanged/empty body and enabled for non-empty changed body.
- After successful save, edit controls close and body view returns.
- Edited text persists in store for the same id.
- Inline card updates in the already-open Monaco zone.
- Edit action is only available when `onUpdateComment` is wired (local worktree diff path). This spec should run on that surface only.

## Edge Cases To Cover Or Explicitly Exclude

- Exclude empty-submit E2E path from this spec; unit tests already cover `updateDiffComment(..., '   ') => false` with no persist.
- Exclude unchanged-submit E2E path; UI prevents submit (`canSubmit === false`) and unit tests cover unchanged no-op.
- Keep one deterministic success path in this spec; do not combine with hover-add, drag-range, or delete interactions.
- Ensure the test interacts with controls inside the Monaco zone, not with detached mock DOM.
- Exclude persist-failure rollback from E2E; keep that in `diffComments.test.ts` where transport can be mocked deterministically.

## Consistency and Concurrency Notes

- `updateDiffComment` return contract is asymmetric by race timing:
  - Missing at pre-check: returns `false` (card stays in edit mode).
  - Missing only by updater time (deleted between pre-check and `set`): returns `true` (treated as benign race/no-op and card closes).
- If another actor updates body while user is editing, draft does not auto-sync mid-edit (`draft` sync is gated by `!editing`), so last writer wins at submit time.
- Persist writes are serialized per worktree in-process only. Cross-window/process coherence depends on external state refresh; this design does not add distributed conflict handling.
- Persist failure rolls back optimistic state only if no newer mutation replaced the same array identity.
- Multi-window stale-read caveat: another window may show old body until its own store refreshes/re-hydrates from persisted metadata.

## Feasibility Constraints

- This is not a one-call backend assertion: E2E must verify both UI interaction and store mutation because view-zone event routing is the primary risk.
- Test depends on dev/test harness surfaces (`window.__store`, `window.api.fs.writeFile`), consistent with existing E2E patterns.
- No claim that edit latency is "free": save awaits async persist (`updateMeta` IPC or runtime RPC with `timeoutMs: 15_000`).
- Do not claim E2E can directly prove "no remove/re-add of zone". It can prove user-visible continuity (same open diff, same inline card location, updated body, closed editor). Internal zone lifecycle remains an implementation detail.

## Rollout

1. Add `tests/e2e/diff-note-edit.spec.ts` using the delete spec structure.
2. Run targeted tests: new edit E2E + `src/renderer/src/store/slices/diffComments.test.ts`.
3. Run `pnpm lint` and `pnpm typecheck`.
