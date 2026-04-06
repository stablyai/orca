# Review Context

## Branch Info

- Base: origin/main
- Current: brennanb2025/file-viewer-preseve-scroll-position

## Changed Files Summary

| File                                                      | Type               |
| --------------------------------------------------------- | ------------------ |
| src/renderer/src/lib/scroll-cache.ts                      | A (new, untracked) |
| src/renderer/src/components/editor/CombinedDiffViewer.tsx | M                  |
| src/renderer/src/components/editor/MarkdownPreview.tsx    | M                  |
| src/renderer/src/components/editor/MonacoEditor.tsx       | M                  |
| src/renderer/src/components/editor/RichMarkdownEditor.tsx | M                  |

## Changed Line Ranges (PR Scope)

| File                                                      | Changed Lines                                |
| --------------------------------------------------------- | -------------------------------------------- |
| src/renderer/src/lib/scroll-cache.ts                      | 1-23 (entire new file)                       |
| src/renderer/src/components/editor/CombinedDiffViewer.tsx | 10, 42-59 (deleted lines replaced by import) |
| src/renderer/src/components/editor/MarkdownPreview.tsx    | 1, 11, 43-104                                |
| src/renderer/src/components/editor/MonacoEditor.tsx       | 1, 12, 94-106, 133-139, 155-167              |
| src/renderer/src/components/editor/RichMarkdownEditor.tsx | 1, 7, 44, 160-218, 395-397                   |

## Review Standards Reference

- Follow /review-code standards
- Focus on: correctness, security, performance, maintainability
- Priority levels: Critical > High > Medium > Low

## File Categories

### Frontend/UI

- src/renderer/src/components/editor/CombinedDiffViewer.tsx
- src/renderer/src/components/editor/MarkdownPreview.tsx
- src/renderer/src/components/editor/MonacoEditor.tsx
- src/renderer/src/components/editor/RichMarkdownEditor.tsx

### Utility/Common

- src/renderer/src/lib/scroll-cache.ts

## Skipped Issues (Do Not Re-validate)

<!-- Issues validated but deemed not worth fixing. Do not re-validate these in future iterations. -->
<!-- Format: [file:line-range] | [severity] | [reason skipped] | [issue summary] -->
<!-- NOTE: Skips should be RARE - only purely cosmetic issues with no functional impact -->

MarkdownPreview.tsx:50-103 + RichMarkdownEditor.tsx:163-217 | Medium | Only 2 identical instances; CombinedDiffViewer variant is substantially different; extraction would touch unrelated code | Duplicated scroll save/restore pattern

## Iteration State

Current iteration: 1
Last completed phase: Validation
Files fixed this iteration: []
