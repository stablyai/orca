# Changes view mode — design doc

Follow-up to #1338 (which cut the fullscreen View Diff modal). This doc captures the revised plan for how diff-viewing should actually work in Orca, replacing Shamoun's original approach.

## Problem

After a user edits a file and hits the close button, the unsaved-changes prompt offers Cancel / Don't Save / Save. Shamoun's PR #1242 added a "View Diff" button that opened a fullscreen modal showing draft-vs-on-disk. That was cut because:

- Fullscreen modals fight the editor — they cover everything.
- The diff-viewing capability is only useful at close time, not continuously.
- There's no natural home for the modal in the UI.

We want a diff-viewing affordance that is (a) reachable from the save dialog, (b) continuously useful mid-edit, and (c) non-intrusive.

## Scope decision: all editable files, not just markdown

Initial thought was markdown-only because competitors (VS Code) gate `compareWithSaved` behind a command. Reconsidered: the "only show when there's a diff" rule makes the visibility cost near-zero. Clean files show nothing; files with uncommitted changes show a toggle — and those are exactly the files where "what did I change?" is useful. Visibility is correlated with utility, not constant.

So: **add Changes mode to both markdown and code files.** Hidden unless the file has a diff against HEAD.

## Mechanism decision: in-place mode swap, not a new tab

Three options considered:

1. **Open a separate diff tab** via the existing `openDiff(worktreeId, filePath, relativePath, language, staged)` store action (`editor.ts:1140`). Used today by the Changes sidebar at `SourceControl.tsx:344`.
   - **Pro:** capability already exists, zero new code in the store/editor layer.
   - **Con:** two tabs for the same file. User has to remember to close the diff tab. "Return to editing" is clicky. Wrong UX for a view-mode toggle.

2. **In-place mode swap** on the existing editor tab. Flip `activeFile.mode` from `'edit'` to `'diff'` and render `DiffViewer` instead of the editor for that tab's contents. Flipping back restores the editor.
   - **Pro:** one tab, fast flip-flip-flip UX, matches the existing `Rendered / Raw` toggle pattern on markdown files.
   - **Con:** today edit-tabs and diff-tabs are *separate tab objects*. Making one tab flip between modes touches editor rendering, tab close semantics, dirty-state plumbing, maybe the autosave controller.

3. **Generalize `markdownViewMode` slice** to a per-tab view mode that all editable files can opt into, with `Changes` as a new value.
   - This is basically option 2 described in state-management terms. The slice at `editor.ts:143` is already keyed by `fileId` and generic in shape; only the mode values (`'rendered' | 'raw'`) are markdown-specific.

**Picking option 2/3.** It's the right UX. The existing `MarkdownViewToggle` at `EditorPanel.tsx:1041` is the pill we extend.

## Meaning of "Changes": git-vs-current, not draft-vs-disk

When the user hits "View Diff" from the save dialog or flips the toggle, what diff do they see?

- **git-vs-current** — working tree (including unsaved draft if dirty) vs HEAD. Matches what the Changes sidebar already shows.
- **draft-vs-on-disk** — what Shamoun's modal was implicitly trying to show.

Picking **git-vs-current**. Reasons:
- Aligns with the Changes sidebar semantics. One "Changes" concept across the app.
- Covers the unsaved-edit case as a subset — dirty buffer contents *are* part of the working tree.
- The original "see what you'd lose before Don't Save" use case still works because the uncommitted edits show up against HEAD.

Caveat: after the user hits "Don't Save," the draft vanishes and the Changes view would still show whatever was changed relative to HEAD on disk. That's fine — it's honest about what the git state actually is.

## Sidebar unification (markdown-only)

Today, clicking a `.md` file in the Changes sidebar opens a dedicated diff-tab type via `openDiff(...)`. With Changes mode in place, markdown gets a more natural home:

- **Change:** markdown files opened from Changes sidebar route to the normal markdown tab with `mode: 'diff'` (view-mode = Changes).
- **Don't change:** the diff-tab type itself — still used for non-markdown code files from the Changes sidebar.
- **Don't change:** how non-markdown code files open from the Changes sidebar — they keep opening as the existing diff-tab type.

Rationale: the sidebar's "open as diff" intent for markdown becomes semantically identical to "flip into Changes mode" once the view mode exists. Code files are a bigger refactor (removing the diff-tab type) and out of scope for this follow-up.

## UI shape

- **Markdown files:** extend the existing `Rendered / Raw` pill to `Rendered / Raw / Changes`. `Changes` segment only visible when `isDirty` or there's a diff against HEAD.
- **Code files:** smaller affordance — probably an `Edit / Changes` two-state toggle, or a single icon button that flips between the two. Decide at implementation time based on what looks natural next to the tab title.
- **Close prompt:** stays minimal (Cancel / Don't Save / Save). No "View Diff" button. Users who want the diff flip the toggle instead. Discoverability is fine because the toggle is visible on any dirty file.

## Open questions — needs investigation before coding

The in-place mode swap is a bigger change than I first thought. Before committing to this design, we should trace:

1. **What assumes "a tab has one mode for its lifetime"?** Tab creation, close semantics, dirty-state plumbing, autosave controller, unified-tab reconciliation. If lots of code branches on `contentType === 'editor'` vs `'diff'`, flipping mode in place is invasive.
2. **Does `DiffViewer` work with dynamically-sourced content?** Today it's given `originalContent` + `modifiedContent` via props. For Changes mode we need to compute those live (HEAD via git, current via working tree / draft). Is there a shared helper we can reuse?
3. **Autosave interaction.** In Changes mode, is the editor still saving on the background timer? The diff view is editable per the design — what writes when the user types in the Changes view?

**Recommended next step:** spawn an Explore agent to answer these three questions before writing any code. That'll tell us whether this is a 100-line PR (mode swap + toggle extension) or a 500-line PR (also pulling apart tab-content assumptions across the editor slice).

## Follow-up work (post this PR)

- Rename `closeEditorIfUnreferenced` → `tryCloseEditorIfUnreferenced` to match its boolean return (landed in #1338).
- Queue + bulk-close integration tests (from the #1338 review doc).
- Eventually: collapse the diff-tab type entirely, so all diff-viewing happens via mode swap on regular editor tabs. Out of scope for now.
