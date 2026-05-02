# PR #1242 — `feat(terminal): view diff on unsaved file close`

Author: @shamounY — branch `shamounY/feat-diff-on-unsaved-file` — closes issue #1237.
Reviewer / scratch-branch owner: @brennanb2025.
PR commit on review: `b56db053` (all line numbers below are relative to this commit's diff against `main`).

## Status

- **Review complete.** No changes pushed to Shamoun's branch or to the scratch branch yet.
- **Next action:** Brennan posts the comment drafted in §7, then executes the cut-list in §5 on local scratch branch `brennanb2025/review-1242-scratch`.
- **Follow-up PR** (markdown Changes view mode) is designed here but not started. See §6.

## Verdict

**🟠 supersede — keep the queue fix, drop the View Diff modal, replace with a markdown-only "Changes" view mode (separate PR).**

The PR bundles two things: (a) a genuine bug fix for dirty-file close paths (split-group, Close All, window quit) and (b) a new "View Diff" fullscreen modal inside the save prompt. The plan is to take this branch onto a local scratch branch, cut the modal, keep the queue + split-group + bulk-close fixes, add two small follow-on fixes, and ship. A separate PR will add diff-viewing as a per-tab view mode for markdown files only. Reasoning in §6.

## 1. Should this feature exist?

Yes — closing #1237 with a save prompt is table stakes. The "View Diff" button is the non-obvious addition here, and it earns its place: users who dismiss dialogs reflexively benefit from a way to see what they'd lose before hitting Don't Save.

Competitor check:
- **VS Code** has `workbench.files.action.compareWithSaved` (see `fileConstants.ts:17`, `fileActions.contribution.ts:390`) but exposes it only as a command / right-click action, not inline in the close prompt. Their close prompt is plain Save/Don't Save/Cancel.
- **emdash** has a conflict dialog (`conflict-dialog.tsx`) for the externally-modified case but no in-prompt diff; only Keep Mine / Accept Incoming.
- **cmux / superset** — no equivalent.

So the "Compare with Saved inside the close prompt" framing is genuinely novel and product-forward, not a reinvention. Good instinct.

**Scope concern — this is actually two PRs bundled.** The diff in `useTabGroupWorkspaceModel.ts` + the queue rewrite + the `closeAllFiles` replacement in `Terminal.tsx` is a non-trivial fix for *already-broken* bulk-close behavior, and it stands on its own. The "View Diff button" is the feature from the title. Normally the queue work should have landed first as a bugfix PR so we could review each cleanly. But the queue rewrite is also a prerequisite for the View Diff flow to work during bulk close without re-opening each dialog incorrectly, so the bundling is defensible. Flagged, no request to split — the split is happening on the scratch branch instead (see §5).

## 2. Is it implemented properly?

Diff is substantive and the bones are good. Findings, in severity order:

### Blocker-adjacent

**`Terminal.tsx:394` and `:1336` — `relativePath.split('/').pop()` is not cross-platform.**
`AGENTS.md` is explicit: never assume `/` or `\`. On Windows, `relativePath` can contain backslashes (our fs layer uses Node's `path.relative`, which returns `\`-separated paths on Windows). Close-dialog title and diff-modal label will show the full path instead of the basename. There's a helper pattern in the repo (`joinPath` in `@/lib/path`) — the right fix is a small `basename` helper or `path.basename(file.relativePath)` via the existing path utility. (Fix will be applied on the scratch branch; `:394` disappears with the modal cut, `:1336` stays and needs the fix.)

**`Terminal.tsx:299` — after save timeout, the dialog is restored but the user loses any diff they were viewing.**
`handleSaveDialogSave` sets `setUnsavedDiffDialogOpen(false)` unconditionally at line 294, then if the save fails (`closed === false`), re-opens the save dialog via `setSaveDialogFileId(fileId)` but does NOT restore the diff modal. If the user was in the diff view and hit Save, a failure bounces them back to the basic prompt with no visual indication that the save failed except the toast. Minor, but fixing it is two lines: cache `wasViewingDiff = unsavedDiffDialogOpen` at the top, and restore on failure.

### Non-blockers

**`Terminal.tsx:321` — empty `catch` comment is weaker than the original.**
Pre-existing code (see the diff at lines 240-248 of the base) said "Quiesce failed — proceed with discard anyway so the user isn't stuck." The new comment at :321 says "Quiesce failure must not trap the user in a close dialog loop." Both are fine, but no `console.warn` on failure means a broken quiesce controller is silently swallowed. Minor, but nwparker's #1023 rule about security-relevant silent catches applies here loosely: this is save-discard ordering, which is close enough to safety. Add a `console.warn`.

**`Terminal.tsx:342-400` — `handleSaveDialogViewDiff` request-id race handling.**
The request-id race handling is correct (nice — rare to see it done right). On second look, the only real issue here is the stale-model flash documented in the next item. Moot for the scratch branch since the modal is being cut.

**Actual subtle bug at `Terminal.tsx:352-357` — loading flag can flash stale content.**
When `handleSaveDialogViewDiff` runs, it sets `setUnsavedDiffModelKey(buildUnsavedDiffModelKey(...))` then `setUnsavedDiffDialogOpen(true)` then `setUnsavedDiffLoading(true)`. But `unsavedDiffModel` from a previous open is still in state. For a single frame before loading renders, the modal can briefly display the previous file's diff. Fix would be to call `setUnsavedDiffModel(null)` alongside `setUnsavedDiffLoading(true)`. Moot for the scratch branch since the modal is being cut — logging for the Changes-mode follow-up, where the same clear-before-load discipline applies.

**`Terminal.tsx:141-152` — five useState + two refs for one modal.**
`unsavedDiffDialogOpen`, `unsavedDiffLoading`, `unsavedDiffError`, `unsavedDiffModelKey`, `unsavedDiffModel` are all state for a single modal. This is borderline — a `useReducer` with `'idle' | 'loading' | 'ready' | 'error'` states would be cleaner and harder to get into invalid combinations (e.g. `loading: true` and `error: 'x'` simultaneously, which the current code does briefly). Not a blocker, but I'd accept a follow-up cleanup.

**`useTabGroupWorkspaceModel.ts:167-178` — new boolean return value is a functional change, not a typo.**
`closeEditorIfUnreferenced` now returns `true | false` where before it returned nothing. That flows through `closeItem` at :211 and `closeMany` at :244. Good: the semantics of "don't close the unified tab if we're waiting on the user" are correct. But the function is named "…IfUnreferenced" — the new return value means "we attempted to close it and there's nothing holding us back," which is different. Consider renaming (`tryCloseEditorIfUnreferenced`, returning `true` on success, `false` when deferred) in a follow-up. Not a blocker.

**SSH compatibility check (AGENTS.md §SSH Use Case):**
`window.api.fs.readFile({ filePath, connectionId })` at `Terminal.tsx:363` goes through the same connection-aware IPC used everywhere else in the editor. Reading over SSH will work. ✅

**Cross-platform keyboard:** no new shortcuts. ✅

**Error handling:** `extractIpcErrorMessage` is used at `Terminal.tsx:383`. ✅

**Tests:** The new unit tests (`unsaved-close-queue.test.ts`, `editor-autosave.test.ts`) cover the extracted helpers correctly. They do *not* cover the state machine in `Terminal.tsx` (queue drain under bulk-close with racing dirty-state flips, save-timeout restoration, view-diff re-entry). That's hard to test without pulling in `@testing-library/react` for the component — and the existing file doesn't have that infra. Fine for this PR; deeper coverage is a separate effort.

**Architectural fit:** headless queue + event-dispatched close-request (`ORCA_EDITOR_REQUEST_FILE_CLOSE_EVENT`) so split-group tab close flows go through the same Terminal.tsx queue — this is correct and matches the pattern already used for `ORCA_EDITOR_SAVE_AND_CLOSE_EVENT`. The `Why:` comment at `useTabGroupWorkspaceModel.ts:170-172` explains exactly why this indirection exists — good adherence to `CLAUDE.md` "document the why." ✅

**Competitor check #2:** VS Code's equivalent (`compareWithSaved`) uses their editor input model to mount a diff side-by-side; it doesn't interrupt the save dialog. The PR's in-dialog approach is fine, but one nit: the diff modal is `w-[calc(100vw-1rem)] h-[calc(100vh-4rem)]` — borderline full-screen. VS Code uses the normal editor area. I'd accept both, but we should make sure this doesn't feel modal-shocky at small window sizes. I tested mentally; it's fine.

### Things I looked at and found nothing wrong

- Queue draining (`getNextQueuedEditorClose` at :211) correctly handles concurrent state changes.
- `handleSaveDialogCancel` (:331) correctly drains the queue so Cancel means "don't save any of them," not just "don't save this one."
- The `useEffect` listener at :402-420 correctly unsubscribes on unmount.
- The `lazy(() => import('./editor/DiffViewer'))` split at :47 avoids pulling Monaco into the main bundle for users who never hit unsaved close.

## 3. Disposition per concern

Many of the line-level nits from §2 become moot because the modal is being removed. Table below resolves each item with an explicit action and owner. Scratch-branch work is in §5, Changes-mode design is in §6.

| Concern | Action | Who |
|---|---|---|
| View Diff modal + state + button | **drop entirely on local scratch branch** | Brennan |
| `relativePath.split('/')` on Windows (`Terminal.tsx:394`, `:1336`) | moot at `:394` (inside diff modal, getting deleted); still needed at `:1336` — fix in scratch | Brennan |
| Stale diff-content flash on re-open | moot (modal deleted) | — |
| Diff dialog not restored on save timeout | moot (modal deleted) | — |
| Silent quiesce failure — add `console.warn` | push on scratch branch | Brennan |
| 5-state modal → reducer refactor | moot (modal deleted) | — |
| `closeEditorIfUnreferenced` rename | keep as nice-to-have follow-up | unassigned |
| Queue + bulk-close behavior tests | real follow-up PR after Changes mode lands | Brennan |
| `buildUnsavedDiffModelKey` helper + test | delete (only used by modal) | Brennan |
| `DiffViewer.tsx` `h-full` one-liner | revert (only needed by modal) | Brennan |

## 4. Design basics

- **Minimal**: 4-button footer (Cancel / View Diff / Don't Save / Save) is the right call — any fewer and the diff button has nowhere to live. Inline diff (`sideBySide={false}`) is the right default for a transient modal.
- **Easy to use**: "Back" to return to the save prompt from the diff view is the right word (clearer than "Close" or the default X). ✅
- **Non-intrusive**: the prompt only appears when the user triggers a close on a dirty file. No preemptive trust/permission prompts. ✅
- **Downscoped**: see scope note in §1. Bundled but defensible.
- **Accessible**: Dialog uses shadcn's Radix-based primitives — ARIA role/focus-trap come for free. Both dialogs have `DialogTitle` + `DialogDescription`. ✅
- **Honest copy**: "Unsaved Diff - filename.ts" is fine. I'd consider "Unsaved Changes — filename.ts" for symmetry with the save dialog's "Unsaved Changes" title, but not a blocker. The description "Compare your current unsaved draft with the saved file on disk." is honest and non-marketing. ✅
- **New patterns**: the close-request-via-CustomEvent pattern matches `ORCA_EDITOR_SAVE_AND_CLOSE_EVENT`. Not inventing anything. ✅
- **Dead plumbing**: none. The `closeAllFiles` store action is still there and still used by `useTerminalTabs.ts` — that's fine, it's just not called from Terminal.tsx anymore. Replacement `handleCloseAllFiles` in Terminal.tsx is load-bearing (it properly queues dirty files instead of dropping them).

Minor copy nit I'll fix on top: "Unsaved Diff - filename.ts" → "Unsaved Changes — filename.ts" (em dash for consistency with other Orca titles).

## 5. Follow-ups

Reasoning for the cut (rather than ship-and-follow-up) is in §6.

**Blockers**: none for the slimmed version.

**Scratch branch:** `brennanb2025/review-1242-scratch`, owned by Brennan, branched from Shamoun's commit `b56db053`. Not pushed to Shamoun's branch; not opened as a PR until the cuts and small fixes below are applied.

**Cuts to apply** (all line numbers relative to `b56db053`):

Cut from `Terminal.tsx`:
- `:47` — `DiffViewer` lazy import
- `:141-151` — the 5 `unsavedDiff*` useStates + `unsavedDiffRequestIdRef`
- `:294`, `:324`, `:334-338` — `setUnsavedDiff*` calls inside save/discard/cancel
- `:342-400` — entire `handleSaveDialogViewDiff`
- `:1324`, `:1326` — the `!unsavedDiffDialogOpen` gating on the save dialog
- `:1344-1346` — the View Diff button
- `:1357-1428` — the entire diff modal Dialog
- `:43` — drop `buildUnsavedDiffModelKey` from the import (keep `appendUniqueOpenFileIds`)
- Also verify `extractIpcErrorMessage` and `getConnectionId` imports, drop if newly unused

Cut from `unsaved-close-queue.ts`:
- `buildUnsavedDiffModelKey` function
- Its test in `unsaved-close-queue.test.ts`

Revert `DiffViewer.tsx`:
- The one-line `h-full` addition (only the modal needed it)

Small fixes kept from the original review:
- `Terminal.tsx:1336` — replace `relativePath.split('/').pop()` with a basename helper (Windows path issue)
- `Terminal.tsx:321` — add `console.warn` on quiesce failure so silent swallow is visible

Then: typecheck + lint + run the unsaved-close-queue and editor-autosave tests to confirm nothing dangles.

**Follow-up PRs Brennan owns:**

1. **"Changes" per-tab view mode — markdown only** — separate PR. Replace the View Diff modal UX for markdown files by extending the existing pill toggle from `Rendered / Raw` to `Rendered / Raw / Changes`. `Changes` renders a Monaco diff of draft vs. on-disk in place of the normal editor view, and only appears when the file is dirty. For code files, *don't* add a persistent pill — code tabs are just text and a permanent view-mode toggle is visual noise with no payoff (competitors don't do this either; VS Code gates `compareWithSaved` behind a command for exactly this reason). Code-file diff affordances can come later via command palette / keyboard shortcut / tab right-click if demand appears.

2. **Queue + bulk-close integration tests** — after Changes mode lands. Not load-bearing.

3. **Rename `closeEditorIfUnreferenced` → `tryCloseEditorIfUnreferenced`** — now that it has a return value. Trivial; group with Changes-mode PR if convenient.

## 6. Design reasoning for the supersede

The View Diff modal is fighting the editor — it's a fullscreen overlay that covers everything because it doesn't have a real home in the UI. The better UX is a per-tab view mode that reuses the existing markdown `Rendered / Raw` pill toggle pattern.

### Why cut now instead of ship-and-follow-up

Merging the modal and then redesigning means the modal code is dead-weight in the codebase for however long the follow-up takes. Cleaner to cut it now and ship the slimmed PR (which still fixes real bugs — see below).

### Why not ask Shamoun to split

Brennan's preference: do the cuts on a local scratch branch rather than round-trip through a split request. The scope concern is real; the negotiation overhead isn't worth it.

### What the slimmed PR actually fixes

Even without View Diff, this PR closes #1237. The single-file save prompt already existed on `main` (`Terminal.tsx:1180`, "Unsaved Changes" dialog at `:1189`). What was broken:

1. **Split-group pane closes bypassed the prompt** — `useTabGroupWorkspaceModel.ts:166` on main called `closeFile(entityId)` directly, no confirmation. Shamoun's PR fixes this via the `requestEditorFileClose` event + boolean-return refactor.
2. **Close All / Close Others / Close Tabs to Right silently dropped dirty files** — the store's `closeAllFiles` bulldozed everything. Shamoun's PR replaces those paths with queue-based prompts.
3. **Window quit with multiple dirty files** — worked before but with duplicated logic across handlers; now unified.

So the issue reporter in #1237 was almost certainly hitting (1) or (2). The commenter who replied "turn on autosave" was mistaken; the feature worked for single-tab close and failed elsewhere.

### The Changes-mode design sketch (inspired by user screenshot)

Screenshot showed a markdown tab header with a pill toggle: `Rendered | Raw | Changes` plus split and close icons, and an orange unsaved-dot next to the filename.

Key design calls:
- **Per-tab view mode, not a modal.** Flip the markdown tab into Changes view, see the diff in place, flip back. Other tabs + terminal + sidebar remain visible.
- **Markdown only for now.** Extend the existing `markdownViewMode` slice (`editor.ts:864`) from `Rendered / Raw` to `Rendered / Raw / Changes`. Don't generalize to code files — a persistent pill on every code tab is noise with no competitor precedent. Revisit if users ask for it.
- **What "Changes" means: git-vs-current (working tree vs HEAD), not draft-vs-on-disk.** This matches what the Changes right sidebar already shows, and it naturally covers the unsaved-edit case (uncommitted dirty edits appear in the git diff too).
- **Only show `Changes` when there's something to show.** Hidden when the markdown file has no diff against HEAD.
- **Editable in Changes view?** Yes — same file model, left gutter shows HEAD state, right pane is the live draft. Matches VS Code's `compareWithSaved` ergonomically.
- **Close prompt stays minimal** (Cancel / Don't Save / Save). Users who want to see diffs pre-close use the pill for markdown. For code files, diff affordances can come later via command/shortcut if demand appears.

### Unifying the Changes sidebar → open-file behavior

Today, clicking a file in the Changes right sidebar opens a dedicated diff-tab type showing the git diff. With the Changes-mode follow-up in place, markdown specifically gets a more natural home: clicking a `.md` file in the Changes sidebar should open the normal markdown tab with view mode set to `Changes`. One tab type for markdown, reachable from either direction (sidebar click or manual pill toggle). The unification only works because both affordances now mean the same thing: git-vs-current.

Scope boundary for this follow-up:
- **Change:** markdown files opened from Changes sidebar route to the normal markdown tab in Changes view mode (instead of the separate diff-tab type).
- **Don't change:** the diff-tab type itself — it's still used for non-markdown code files from the Changes sidebar, and removing it would be out of scope.
- **Don't change:** how non-markdown code files open from the Changes sidebar — they keep opening as the existing diff-tab type.

### Why this design is better than the modal

- **Non-intrusive** — one of Orca's design values. The modal is maximally intrusive; per-tab view mode is maximally non-intrusive.
- **Composes with existing infra** — reuses the Rendered/Raw toggle pattern the user already knows.
- **Useful continuously, not just at close time.** "Did I change something weird?" is a mid-edit question too, not just a close-time one. VS Code gates `compareWithSaved` behind a command for exactly this reason; Orca can do better by making it a persistent view mode.
- **Fixes bulk-close UX.** Reviewing 5 dirty files before quitting becomes flip-flip-flip-flip-flip rather than five fullscreen modals.
- **Minimal visual surface.** Three words in a pill toggle vs. a full Dialog component.

## 7. Suggested comment to the author

Draft (not yet sent — Brennan to review before posting):

---

Thanks @shamounY — the queue + split-group refactor is the load-bearing fix for #1237 and I'll land that. I'm going to take it onto a local scratch branch and ship that part alone, cutting the View Diff modal. Not a code concern — we just want to surface the diff as a per-tab view mode (extending the markdown `Rendered / Raw` pill to `Rendered / Raw / Changes`) rather than a fullscreen modal. That'll ship separately, owned by me. Also fixing a few things on top of the queue work (in-flight save races, dirty tabs surviving Close Others / Close to Right, a Windows path bug) — commits will be visible on the follow-up PR.

---
