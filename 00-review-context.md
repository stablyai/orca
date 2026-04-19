# Review Context

## Branch Info

- Base: origin/main (merge-base `1ea2a6d7`)
- Current: brennanb2025/help-me-support-adding-comment-onto-specific-lin

## Notes

The PR contains 1415 changed files, but ~1395 of them are compiled `.d.ts` / `.js`
build artifacts accidentally committed in the WIP checkpoint. They are not real
source changes and will be IGNORED for review purposes. Only the original
`.ts` / `.tsx` / `.css` source files (listed below) are in scope.

The compiled artifacts are listed in `.gitignore`-adjacent build output and
should almost certainly be removed from the commit — but that cleanup is out of
scope for the review itself (it is a mechanical issue, not a code-quality one).
A review finding will call it out.

## Changed Files Summary (source only)

| Status | File                                                                        |
| ------ | --------------------------------------------------------------------------- |
| M      | src/main/ipc/worktree-logic.ts                                              |
| M      | src/preload/index.d.ts                                                      |
| M      | src/renderer/src/assets/main.css                                            |
| A      | src/renderer/src/components/diff-comments/DiffCommentPopover.tsx            |
| A      | src/renderer/src/components/diff-comments/DiffCommentsAgentChooserDialog.tsx|
| A      | src/renderer/src/components/diff-comments/DiffCommentsTab.tsx               |
| A      | src/renderer/src/components/diff-comments/useDiffCommentDecorator.ts        |
| M      | src/renderer/src/components/editor/CombinedDiffViewer.tsx                   |
| M      | src/renderer/src/components/editor/DiffSectionItem.tsx                      |
| M      | src/renderer/src/components/editor/EditorContent.tsx                        |
| A      | src/renderer/src/lib/diff-comments-format.test.ts                           |
| A      | src/renderer/src/lib/diff-comments-format.ts                                |
| M      | src/renderer/src/store/index.ts                                             |
| A      | src/renderer/src/store/slices/diffComments.ts                               |
| M      | src/renderer/src/store/slices/editor.ts                                     |
| M      | src/renderer/src/store/slices/store-session-cascades.test.ts                |
| M      | src/renderer/src/store/slices/store-test-helpers.ts                         |
| M      | src/renderer/src/store/slices/tabs.test.ts                                  |
| M      | src/renderer/src/store/types.ts                                             |
| M      | src/shared/types.ts                                                         |

## Changed Line Ranges (PR Scope)

<!-- In scope: issues on these lines OR caused by these changes. -->

| File                                                                         | Changed Lines                                                                                       |
| ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| src/main/ipc/worktree-logic.ts                                               | 166-167                                                                                             |
| src/preload/index.d.ts                                                       | whole-file simplification (removed inline `ReposApi` etc. in favor of `PreloadApi`)                 |
| src/renderer/src/assets/main.css                                             | 861-994 (new diff-comment styles)                                                                   |
| src/renderer/src/components/diff-comments/DiffCommentPopover.tsx             | 1-106 (new file)                                                                                    |
| src/renderer/src/components/diff-comments/DiffCommentsAgentChooserDialog.tsx | 1-114 (new file)                                                                                    |
| src/renderer/src/components/diff-comments/DiffCommentsTab.tsx                | 1-215 (new file)                                                                                    |
| src/renderer/src/components/diff-comments/useDiffCommentDecorator.ts         | 1-249 (new file)                                                                                    |
| src/renderer/src/components/editor/CombinedDiffViewer.tsx                    | 7, 60-61, 499-506                                                                                   |
| src/renderer/src/components/editor/DiffSectionItem.tsx                       | 1, 10-13, 113-125, 133-179, 201, 212, 215-216, 221-222, 225-226, 301, 316-323                       |
| src/renderer/src/components/editor/EditorContent.tsx                         | 15-17, 221-224                                                                                      |
| src/renderer/src/lib/diff-comments-format.test.ts                            | 1-72 (new file)                                                                                     |
| src/renderer/src/lib/diff-comments-format.ts                                 | 1-23 (new file)                                                                                     |
| src/renderer/src/store/index.ts                                              | 17, 33-34                                                                                           |
| src/renderer/src/store/slices/diffComments.ts                                | 1-173 (new file)                                                                                    |
| src/renderer/src/store/slices/editor.ts                                      | 101, 210, 1102-1139                                                                                 |
| src/renderer/src/store/slices/store-session-cascades.test.ts                 | 101, 118-119                                                                                        |
| src/renderer/src/store/slices/store-test-helpers.ts                          | 25, 50-51                                                                                           |
| src/renderer/src/store/slices/tabs.test.ts                                   | 96, 115-116                                                                                         |
| src/renderer/src/store/types.ts                                              | 15, 30-31, 48, 62-78                                                                                |
| src/shared/types.ts                                                          | minor additions                                                                                     |

## Review Standards Reference

- Follow /review-code standards
- Focus on: correctness, security, performance, maintainability
- Priority levels: Critical > High > Medium > Low

## File Categories

### Electron/Main (priority 1)

- src/main/ipc/worktree-logic.ts
- src/preload/index.d.ts

### Backend/IPC (priority 2)

- (none — IPC for this PR lives entirely in renderer)

### Frontend/UI (priority 3)

- src/renderer/src/assets/main.css
- src/renderer/src/components/diff-comments/DiffCommentPopover.tsx
- src/renderer/src/components/diff-comments/DiffCommentsAgentChooserDialog.tsx
- src/renderer/src/components/diff-comments/DiffCommentsTab.tsx
- src/renderer/src/components/diff-comments/useDiffCommentDecorator.ts
- src/renderer/src/components/editor/CombinedDiffViewer.tsx
- src/renderer/src/components/editor/DiffSectionItem.tsx
- src/renderer/src/components/editor/EditorContent.tsx

### Config/Build (priority 4)

- (none)

### Utility/Common (priority 5)

- src/renderer/src/lib/diff-comments-format.ts
- src/renderer/src/lib/diff-comments-format.test.ts
- src/renderer/src/store/index.ts
- src/renderer/src/store/slices/diffComments.ts
- src/renderer/src/store/slices/editor.ts
- src/renderer/src/store/slices/store-session-cascades.test.ts
- src/renderer/src/store/slices/store-test-helpers.ts
- src/renderer/src/store/slices/tabs.test.ts
- src/renderer/src/store/types.ts
- src/shared/types.ts

## Skipped Issues (Do Not Re-validate)

| File:lines | Severity | Reason | Summary |
| --- | --- | --- | --- |
| src/main/ipc/worktree-logic.ts:10-16 | High | False positive — regex was never in merge-base | "`.replace(/\.{2,}/g, '.')` removed" — never existed at 1ea2a6d7 |
| src/renderer/src/store/slices/diffComments.ts:1 | Low | Cosmetic naming | Rename to kebab-case — would update 4-5 import sites for zero behavior change |
| src/renderer/src/components/diff-comments/useDiffCommentDecorator.ts:170-220 | Medium | Intentional architecture; would require large rewrite | Imperative view-zone DOM vs ReactDOM.createRoot |
| branch-wide | High | Commit surgery, separate PR-prep task | ~1395 compiled .d.ts/.js build artifacts accidentally committed in WIP checkpoint |
| src/shared/types.ts:68 | Low | Forward-compat speculation | `side: 'modified'` too narrow |
| src/shared/types.ts | Medium | Speculative v2 schema | Add `parentId?`/`resolvedAt?` for future threading |
| src/renderer/src/components/diff-comments/DiffCommentPopover.tsx:65 | Low | UX nice-to-have; would require Radix FocusScope import | Full focus trap |
| src/renderer/src/components/diff-comments/DiffCommentsTab.tsx:81 | Low | Minor UX | pasteNotice never auto-clears |
| src/renderer/src/components/diff-comments/DiffCommentsTab.tsx:80 | Low | Self-directed terminal; `\r`/`\n` already escaped upstream | No ANSI/control-char sanitization before pty.write |
| src/renderer/src/components/diff-comments/useDiffCommentDecorator.ts:236-238 | Low | Micro-optimization | querySelector instead of ref map |
| src/renderer/src/components/diff-comments/useDiffCommentDecorator.ts:208 | Low | Edge case; documented in inline comment | Long soft-wrapped body clips view-zone |
| src/renderer/src/components/diff-comments/useDiffCommentDecorator.ts:47 | Low | Common useEvent pattern | Ref assignments during render |
| src/main/ipc/worktree-logic.ts:167 | Medium | Architectural tradeoff | diffComments embedded in Worktree IPC payload |
| src/renderer/src/components/editor/DiffSectionItem.tsx:119 | Medium | Selector is already reference-stable for unrelated updates | Per-section re-render cascade |
| src/renderer/src/store/slices/diffComments.ts:27 | Low | Doc nit | Add "Why" comment for bypassing updateWorktreeMeta |
| src/renderer/src/store/slices/diffComments.ts:81 | Medium | Test infrastructure investment | Add rollback concurrency tests |
| src/renderer/src/lib/diff-comments-format.ts:12 | Low | No concrete breakage, speculative | Expand escape set to U+2028/U+2029/NUL |
| src/renderer/src/components/diff-comments/DiffCommentsTab.tsx:62 | Low | Doc nit | Document why handlePaste calls IPC directly |
| src/renderer/src/store/slices/editor.ts:1102 | Low | Sweeping refactor | Refactor `OpenFile` to discriminated union |
| src/renderer/src/components/diff-comments/useDiffCommentDecorator.ts:92 | Low | Listener is removed via `plus.remove()` | Mousedown listener cleanup symmetry |
| src/renderer/src/components/diff-comments/useDiffCommentDecorator.ts:181 | Low | Intended UX split (tab view is keyboard surface) | Inline delete keyboard access |
| src/renderer/src/store/slices/diffComments.ts:143 | Low | API symmetry nit | delete/clear return void instead of boolean |
| src/renderer/src/components/diff-comments/useDiffCommentDecorator.ts:98 | Medium | Product design decision, not review fix | Keyboard path to add comment |
| src/renderer/src/components/diff-comments/DiffCommentPopover.tsx:46 | Low | Theoretical, hasn't materialized | pointerdown capture + composedPath |
| src/renderer/src/components/diff-comments/DiffCommentPopover.tsx:69 | Low | Speculative for future left-side comments | Hardcoded right:24px position |
| src/renderer/src/components/diff-comments/DiffCommentsAgentChooserDialog.tsx:33-68 | Medium | Existing minor UX; unmount race rare | setState-after-unmount + unhandled `ensureAgentStartupInTerminal` rejection |
| src/renderer/src/components/diff-comments/DiffCommentsAgentChooserDialog.tsx:70-114 | Low | Radix warning nit | Missing DialogDescription |
| src/renderer/src/components/diff-comments/DiffCommentsTab.tsx:180-205 | Low | Radix warning nit | Missing DialogDescription in clear-all dialog |
| src/renderer/src/components/diff-comments/DiffCommentPopover.tsx:27-29 | Low | Addressed by FIX-10 (key prop) | Popover reuse retains prior draft (duplicate of FIX-10) |
| src/renderer/src/components/editor/CombinedDiffViewer.tsx:61 | Low | Speculative future concern | getDiffComments selector future misuse |
| src/renderer/src/components/editor/DiffSectionItem.tsx:146-164 | Low | Already commented inline | Effect dep suppression comment |
| src/main/ipc/worktree-logic.ts (Claude algo-arch duplicate of FIX-1) | High | Duplicate of FIX-1 | `repos.add`/`addRemote` return type |

## Iteration State

Current iteration: 1
Last completed phase: Validation
Files fixed this iteration: []
Pending fixes: 12 (FIX-1 through FIX-12)
