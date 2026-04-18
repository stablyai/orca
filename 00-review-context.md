# Review Context

## Branch Info

- Base: origin/main
- Current: brennanb2025/help-me-support-adding-comment-onto-specific-lin

## Changed Files Summary

Modified (M):
- src/main/ipc/worktree-logic.ts
- src/preload/index.d.ts (⚠️ WIPED to `export {};` — likely unintended)
- src/renderer/src/assets/main.css
- src/renderer/src/components/editor/CombinedDiffViewer.tsx
- src/renderer/src/components/editor/DiffSectionItem.tsx
- src/renderer/src/components/editor/EditorContent.tsx
- src/renderer/src/store/index.ts
- src/renderer/src/store/slices/editor.ts
- src/renderer/src/store/slices/store-session-cascades.test.ts
- src/renderer/src/store/slices/store-test-helpers.ts
- src/renderer/src/store/slices/tabs.test.ts
- src/renderer/src/store/types.ts
- src/shared/types.ts

Added (A, staged via -N):
- src/renderer/src/components/diff-comments/DiffCommentPopover.tsx
- src/renderer/src/components/diff-comments/DiffCommentsAgentChooserDialog.tsx
- src/renderer/src/components/diff-comments/DiffCommentsTab.tsx
- src/renderer/src/components/diff-comments/useDiffCommentDecorator.ts
- src/renderer/src/lib/diff-comments-format.ts
- src/renderer/src/lib/diff-comments-format.test.ts
- src/renderer/src/store/slices/diffComments.ts

## Changed Line Ranges (PR Scope)

<!-- In scope: issues on these lines OR caused by these changes. Out of scope: unrelated pre-existing issues -->

| File                                                               | Changed Lines                                                                                              |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| src/main/ipc/worktree-logic.ts                                     | 166-167                                                                                                    |
| src/preload/index.d.ts                                             | 1 (entire file, wiped)                                                                                     |
| src/renderer/src/assets/main.css                                   | 861-994                                                                                                    |
| src/renderer/src/components/editor/CombinedDiffViewer.tsx          | 7, 60-61, 499-506                                                                                          |
| src/renderer/src/components/editor/DiffSectionItem.tsx             | 1, 10-13, 113-125, 133-159, 181, 192, 195-196, 201-202, 205-206, 281, 296-303                              |
| src/renderer/src/components/editor/EditorContent.tsx               | 15-17, 221-224                                                                                             |
| src/renderer/src/store/index.ts                                    | 17, 33-34                                                                                                  |
| src/renderer/src/store/slices/editor.ts                            | 101, 210, 1102-1139                                                                                        |
| src/renderer/src/store/slices/store-session-cascades.test.ts       | 101, 118-119                                                                                               |
| src/renderer/src/store/slices/store-test-helpers.ts                | 25, 50-51                                                                                                  |
| src/renderer/src/store/slices/tabs.test.ts                         | 96, 115-116                                                                                                |
| src/renderer/src/store/types.ts                                    | 15, 30-31                                                                                                  |
| src/shared/types.ts                                                | 48, 62-78                                                                                                  |
| src/renderer/src/components/diff-comments/DiffCommentPopover.tsx            | ALL (new file)                                                                                    |
| src/renderer/src/components/diff-comments/DiffCommentsAgentChooserDialog.tsx | ALL (new file)                                                                                   |
| src/renderer/src/components/diff-comments/DiffCommentsTab.tsx               | ALL (new file)                                                                                    |
| src/renderer/src/components/diff-comments/useDiffCommentDecorator.ts        | ALL (new file)                                                                                    |
| src/renderer/src/lib/diff-comments-format.ts                                | ALL (new file)                                                                                    |
| src/renderer/src/lib/diff-comments-format.test.ts                           | ALL (new file)                                                                                    |
| src/renderer/src/store/slices/diffComments.ts                               | ALL (new file)                                                                                    |

## Review Standards Reference

- Follow /review-code standards
- Focus on: correctness, security, performance, maintainability
- Priority levels: Critical > High > Medium > Low

## File Categories

### Electron/Main (src/main/, src/preload/, electron.*)
- src/main/ipc/worktree-logic.ts
- src/preload/index.d.ts

### Frontend/UI (src/renderer/, components/, *.tsx, *.css)
- src/renderer/src/assets/main.css
- src/renderer/src/components/editor/CombinedDiffViewer.tsx
- src/renderer/src/components/editor/DiffSectionItem.tsx
- src/renderer/src/components/editor/EditorContent.tsx
- src/renderer/src/components/diff-comments/DiffCommentPopover.tsx
- src/renderer/src/components/diff-comments/DiffCommentsAgentChooserDialog.tsx
- src/renderer/src/components/diff-comments/DiffCommentsTab.tsx
- src/renderer/src/components/diff-comments/useDiffCommentDecorator.ts
- src/renderer/src/store/index.ts
- src/renderer/src/store/slices/editor.ts
- src/renderer/src/store/slices/diffComments.ts
- src/renderer/src/store/slices/store-session-cascades.test.ts
- src/renderer/src/store/slices/store-test-helpers.ts
- src/renderer/src/store/slices/tabs.test.ts
- src/renderer/src/store/types.ts
- src/renderer/src/lib/diff-comments-format.ts
- src/renderer/src/lib/diff-comments-format.test.ts

### Utility/Common (shared)
- src/shared/types.ts

## Skipped Issues (Do Not Re-validate)

<!-- Format: [file:line-range] | [severity] | [reason skipped] | [issue summary] -->

- [src/shared/types.ts:48,62] | Medium | Matches existing pattern consistently (all persisted meta fields mirror onto Worktree: displayName, comment, linkedIssue, linkedPR, isArchived, isUnread, isPinned, sortOrder, lastActivityAt). Moving diffComments alone to a renderer-only slice would introduce an inconsistency. | diffComments? appears on both Worktree and WorktreeMeta.
- [src/shared/types.ts:72] | Medium | DiffComment.worktreeId denormalization matches the existing Tab/TabGroup pattern (Tab.worktreeId at line 109) where child records carry parent id. Consistency with codebase. | DiffComment.worktreeId duplicates container key.
- [src/renderer/src/components/diff-comments/useDiffCommentDecorator.ts:60,88-103] | High | Keyboard-accessibility entry point is out of scope for this PR; a "+" button on hover is the standard pattern in similar feature (e.g. GitHub, GitLab diffs). The design doc / feature request explicitly describes a hover gesture. | "+" button only visible on mouse hover.
- [src/renderer/src/components/diff-comments/DiffCommentsAgentChooserDialog.tsx:40-61] | Medium | Helper-extract refactor is out of scope; the composer code already uses the shared helpers buildAgentStartupPlan+ensureAgentStartupInTerminal. Only the 6-line launcher glue is duplicated — cosmetic at this scale. | Duplicates composer's launch glue.
- [src/renderer/src/components/diff-comments/DiffCommentsTab.tsx:60-80] | Low | Same architectural tier as existing "send to terminal" patterns; extracting a helper is a follow-up refactor, no bug today. | Reinvents "send text to active terminal".
- [src/renderer/src/components/diff-comments/DiffCommentsTab.tsx:10-28] | Low | Timestamp live-refresh is polish; no functional bug. | formatTimestamp does not live-update.
- [src/renderer/src/components/diff-comments/DiffCommentsTab.tsx:53,67] | Low | Minor stylistic mix; no correctness issue. | Mixed useAppStore selector + getState() in handler.
- [src/renderer/src/components/diff-comments/DiffCommentPopover.tsx:26-33] | Low | Currently dead (body starts as ''). | autoResize not called on initial mount.
- [src/renderer/src/components/diff-comments/useDiffCommentDecorator.ts:58-59] | Low | Static SVG literal, no user data. | plus.innerHTML XSS pattern (static only).
- [src/renderer/src/components/diff-comments/useDiffCommentDecorator.ts:75-84] | Low | Edge case with stale hoverLineRef; negligible impact. | Stale hoverLineRef after scroll.
- [src/renderer/src/components/diff-comments/useDiffCommentDecorator.ts:68-73] | Medium | hideUnchangedRegions handling is a polish concern; the feature works correctly in the common case. | Decorator doesn't account for folded regions.
- [src/renderer/src/components/editor/DiffSectionItem.tsx:135] | Low | Multiple simultaneous popovers is a UX polish issue; no correctness bug. | Per-section popover state allows two popovers.
- [src/renderer/src/store/slices/editor.ts:1102-1138] | Low | Existing openConflictReview precedent; comment already explains guard. No current break. | openDiffCommentsTab stuffs worktreePath into filePath.
- [src/renderer/src/components/diff-comments/DiffCommentsTab.tsx:146-158] | Low | Intentional persistence; not a bug. | addDiffComment continues after unmount.
- [src/renderer/src/components/editor/DiffSectionItem.tsx,DiffCommentPopover.tsx:146-158,35-41] | Low | Success is the common case; no silent data loss (rollback restores). Could be polish. | No user-visible error toast on persist failure.
- [src/renderer/src/components/diff-comments/DiffCommentsAgentChooserDialog.tsx:33-68] | Low | Stale busy/error on reopen is polish. | Dialog state not reset on close.
- [src/renderer/src/components/diff-comments/DiffCommentsAgentChooserDialog.tsx:33-46] | Low | Captured prop vs store is standard; delete UI is obviously racy with any modal. | comments prop drifts vs store.
- [src/renderer/src/components/diff-comments/DiffCommentsAgentChooserDialog.tsx:52-60] | Low | `ensureAgentStartupInTerminal` resolves via activeTabIdByWorktree which was just set to newTab.id; the poll re-reads state each tick. Works. | Agent-chooser follow-up tab resolution.
- [src/renderer/src/components/diff-comments/DiffCommentsAgentChooserDialog.tsx:52-54] | Low | Both calls currently needed; refactor out of scope. | setActiveTabType call potentially redundant.
- [src/renderer/src/store/slices/diffComments.ts:15-20] | Low | Electron renderer always has crypto.randomUUID; fallback is dead-code defensive. | generateId fallback collision risk.
- [src/renderer/src/assets/main.css:872] | Low | Cosmetic; works correctly. | Inline style vs CSS display ownership.
- [src/renderer/src/store/slices/diffComments.ts] | Medium | Slice unit-test coverage is nice-to-have; time-boxed. | No unit tests on slice.
- [src/renderer/src/lib/diff-comments-format.test.ts:42-51] | Low | toContain coverage is sufficient; tightening to toBe is nice-to-have. | multi-comment test uses toContain.
- [src/shared/types.ts:70-79] | Low | No edit flow exists in v1; updatedAt premature. | No updatedAt on DiffComment.
- [src/shared/types.ts:77-78] | Low | Migration story documented via comment; adding an explicit version field is premature. | side discriminator/version design.
- [src/main/ipc/worktree-logic.ts:166-167] | Medium | The updateMeta "last write wins" pattern is established for ALL meta fields. Same tradeoff as displayName/comment/etc. Follow-up for the scale discussion. | IPC write-amplification on comments blob.
- [src/renderer/src/components/editor/DiffSectionItem.tsx:180-195] | Medium | onDidDispose guarding is defensive; current remount-on-generation behaviour handles this. | Decorator doesn't guard against Monaco editor.onDidDispose.

## Iteration State

Current iteration: 1
Last completed phase: Review
Files fixed this iteration: []
