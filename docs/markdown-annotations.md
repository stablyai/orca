# Markdown Annotations

## Reality Check (Current Code)

- Notes persist on `WorktreeMeta.diffComments: DiffComment[]`.
- `DiffComment` has: `id`, `worktreeId`, `filePath`, `lineNumber`, `body`, `createdAt`, `side: 'modified'`.
- `DiffComment` does **not** have `source` or `startLine` yet.
- Diff note persistence is optimistic with rollback and a per-worktree serialized write queue in `diffComments` slice.
- Queue ordering is only per renderer store. Multi-window still has last-write-wins races.
- Inline note UI (`useDiffCommentDecorator`, `DiffCommentPopover`, `DiffCommentCard`) is wired on diff surfaces (`DiffViewer`, `DiffSectionItem`) only.
- `MonacoEditor` (markdown source) and `MarkdownPreview` currently have no annotation integration.
- Source Control notes shelf renders all `diffComments` and sends via `launchSource="diff_notes_send"`.

## Correction: Existing Range UX Is Partially Dropped

Diff UI already supports drag range selection and popover carries `startLine`, but `addDiffComment(...)` drops it because the type/store schema has nowhere to persist it.

Implication:
- Range labels are not durable today.
- Any markdown block-span design must add persisted `startLine` first or it will regress to single-line anchors after save/reload.

## Required Data Model Change

Extend `DiffComment` (backward compatible):

- `source?: 'diff' | 'markdown'` (`undefined` means legacy `'diff'`).
- `startLine?: number`.

Rules:
- Keep `lineNumber` as canonical anchor.
- `startLine` must satisfy `1 <= startLine <= lineNumber`.
- Do not rename/remove existing fields.

## Authoring Surfaces

### Markdown source (`MonacoEditor`)

- Wire `useDiffCommentDecorator` when `language === 'markdown'` and `worktreeId` exists.
- Filter comments by `(worktreeId, filePath === relativePath, source === 'markdown')`.
- Reuse existing popover/card UI and CRUD.
- `EditorContent` must pass `worktreeId` into `MonacoEditor`.

### Markdown preview (`MarkdownPreview`)

- Use `react-markdown` AST positions (`node.position.start.line`) for block anchors.
- Add one add-note affordance per eligible block (not per inline span).
- Persist as markdown note with resolved source line/range.
- Render existing notes under matching blocks.
- If a note cannot be mapped to any rendered block, keep it in shelf and open source mode at its line.

## Source Control Behavior

- Notes shelf should show both note sources.
- `handleOpenComment` must branch by note source:
  - `diff` or legacy `undefined`: current diff routing.
  - `markdown`: open file in editor, force markdown source mode, reveal line, and route pending note scroll to markdown decorator.
- Do not send a markdown note through diff-only context formatting.

## Prompt Formatting Contract

Current formatter only outputs:
- `File: ...`
- `Line: ...`
- `User comment: "..."`

Required:
- Preserve exact legacy output for legacy/diff notes.
- Add explicit source metadata for markdown notes.
- Include range when `startLine` exists (for example `Lines A-B`).

## Telemetry

`LaunchSource` currently includes `diff_notes_send` only.

Required:
- Add a markdown-capable launch source value (or replace with a generic notes value and migrate all call sites).
- Update schema + all typed call sites together; this is not free.

## Consistency and Concurrency Gaps to Acknowledge

- Multi-window: independent renderer stores can overwrite each other’s `diffComments` snapshots.
- External mutations (rename/delete): `filePath` anchors can drift; unresolved notes must remain accessible from shelf.
- Split panes: pending-scroll consumption must stay one-shot and scoped so one pane does not consume another pane’s request.
- No automatic re-anchoring after source edits in v1.

## Non-goals (v1)

- No markdown file content mutation for annotations.
- No rich markdown (`mdViewMode === 'rich'`) authoring surface.
- No remote review-thread sync.
- No automatic anchor healing.

## Implementation Order

1. Extend `DiffComment` type and persistence path (`source`, `startLine`) with compatibility guards.
2. Update formatter to keep legacy diff output stable while adding markdown/range encoding.
3. Wire markdown-source decorator in `MonacoEditor` and pass `worktreeId` from `EditorContent`.
4. Add preview block mapping/authoring/rendering in `MarkdownPreview`.
5. Update Source Control open/send logic for mixed note sources.
6. Add telemetry enum/schema/caller updates.
7. Add focused tests for formatter compatibility, source-based routing, and unresolved-anchor fallbacks.
