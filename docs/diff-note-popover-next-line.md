# Diff Note Popover Next Line

## Problem

Adding a note from a diff line opens the note popover at the annotated line's top edge, covering the line being annotated.

- `useDiffCommentDecorator.tsx` computes popover `top` from `getTopForLineNumber(lineNumber) - getScrollTop()` when drag/selection ends.
- `DiffViewer.tsx` and `DiffSectionItem.tsx` recompute `top` with the same formula on scroll/content-size updates.
- `DiffCommentPopover.tsx` applies that `top` directly to an absolutely positioned overlay (`.orca-diff-comment-popover` in `main.css`).

## Root Cause

Anchor math uses the line's top edge. The popover is an overlay sibling above Monaco (not a Monaco zone), so top-edge anchoring places the card over the annotated line.

## Non-goals

- Do not change saved note rendering; saved notes already use Monaco view zones after the annotated line.
- Do not introduce a modal, Radix popover, or focus-management rewrite.
- Do not change note persistence, range selection semantics, or GitHub PR comment behavior.
- Do not add editor padding or permanent blank rows before a note exists.

## Design

1. Add a shared helper (renderer-local) for draft-popover Y position:
   `top = getTopForLineNumber(anchorLine) - getScrollTop() + lineHeight`.
2. Read `lineHeight` from Monaco (`editor.getOption(EditorOption.lineHeight)`), with fallback `19` to match existing defensive behavior in the decorator.
3. Keep the existing range anchor rule: `anchorLine = max(startLine, endLine)` so multi-line note popovers open below the last selected line.
4. Replace all three popover top calculations with the helper:
   - initial open in `useDiffCommentDecorator`
   - live tracking in `DiffViewer`
   - live tracking in `DiffSectionItem`
5. Guard recomputation if the editor has no model or `anchorLine` is outside model bounds; close the draft popover instead of rendering at a stale/invalid Y after external edits.

## Edge Cases

- Multi-line selection: popover opens below the final selected line.
- Scroll/content relayout while open: recomputation keeps popover on the next line.
- Font zoom / runtime line-height changes: helper reads current Monaco line height each recompute.
- External mutations while popover is open (local edits, patch refresh, branch switch): if anchor line disappears, close popover.
- Near viewport bottom: popover may clip; this is existing overlay behavior and out of scope.
- Full-file (`DiffViewer`) and sectioned (`DiffSectionItem`) diffs must remain behaviorally identical.

## Rollout

1. Add helper + unit tests (valid line, missing model, out-of-range line, custom line height, fallback line height).
2. Wire helper into decorator open path and both viewer recompute paths.
3. Run `pnpm typecheck` and `pnpm lint`.
4. Verify manually on both diff surfaces:
   - single-line note
   - multi-line drag note
   - scroll/resize/zoom while popover is open
   - branch/content refresh with popover open
