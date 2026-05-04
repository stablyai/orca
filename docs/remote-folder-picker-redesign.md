# Remote SSH Folder Picker — Redesign Proposal

## Context

The "Browse remote filesystem" dialog lets users pick a directory on a connected SSH target to open as a remote project. It's reached from: sidebar → Add project → Open remote project → folder-picker icon next to the Remote path input.

**Source:** `src/renderer/src/components/sidebar/RemoteFileBrowser.tsx`
**Invoked from:** `src/renderer/src/components/sidebar/AddRepoSteps.tsx` (`RemoteStep`, around line 167)

## User complaints

1. **Hard to find the desired folder** — list is flat and unfiltered; on a home directory with 30+ dotfiles/dirs, you scroll.
2. **Nested folders not discoverable as navigable** — current model is single-click = highlight, double-click = navigate. Users don't discover the double-click.
3. **Unclear consequence of pressing "Select"** — button is generic; the dialog doesn't say what happens to the chosen folder next.

## Current behavior (for reference)

- Single-click a row → sets `selectedName`, highlights the row.
- Double-click a folder row → navigates into it.
- "Select" button → if a row is highlighted, returns `<resolvedPath>/<selectedName>`; otherwise returns `resolvedPath` (the current directory).
- Breadcrumb bar at top with ↑, 🏠, and clickable path segments.
- Footer shows the path that will be returned: either current dir or `current/highlighted`.

## Reference: how others do it

- **VS Code** (`simpleFileDialog.ts`): one unified input at the top doubles as (a) current path, (b) filter as you type, (c) editable path entry. Enter key navigates into folders; OK button label is caller-supplied ("Open Folder", etc.). Auto-complete suggests folders inline.
- **Superset, Warp**: no comparable picker.

## Options considered

### Option A — VS Code-style: selection = current directory
Drop the "highlight a row" model entirely. Navigate into the folder you want (single-click enters it), then "Select" always returns the current directory.

**Rejected because:** breaks Finder/Explorer muscle memory (double-click to open is a universal convention), and adds a click for the common case of picking a visible child folder.

### Option B — chevron-on-folders affordance
Add a `›` navigation button on folder rows to make "enter this folder" discoverable to mouse users. A permanent chevron is visual noise, so we show it only on row hover (and on keyboard focus for a11y parity).

### Option C — add a filter input
Add a text input at the top of the list that live-filters visible entries by substring. No change to the selection model.

### Chosen: Option C + Option B
The filter input (C) addresses complaint #1 and surfaces `Enter`-to-navigate for keyboard users. The hover/focus chevron (B) addresses complaint #2 for mouse users without the visual noise of a permanent affordance. The two are independent and compose cleanly.

## Proposed change

### 1. Filter input (addresses complaint #1)

- Add a text input above the file list (below the breadcrumb bar) that auto-focuses on mount. The picker only mounts when the outer dialog opens (verified: `AddRepoSteps.tsx` conditionally renders `RemoteFileBrowser` based on dialog-open state), so the auto-focus cannot steal focus from the outer dialog's inputs.
- Live-filter `entries` by case-insensitive substring match on `entry.name`. **Filters both files and folders** — hiding files would confuse users trying to confirm they're in the right directory (e.g. looking for a README). Files remain non-actionable.
- Keyboard (handled on the input's `onKeyDown`):
  - `↓` / `↑` — move the highlight (`selectedName`) through the *filtered* list. `preventDefault` so the caret doesn't jump. Clamps at the ends: ArrowUp at the first filtered entry (or with nothing highlighted) stays put; it never triggers parent-directory navigation. Parent-nav is exclusively the breadcrumb `↑` button.
  - `Enter` — precedence: (a) if a folder is highlighted, navigate into it; (b) else if a **file** is highlighted, surface the transient footer hint (below) and do not navigate; (c) else if the filtered set contains exactly one folder (regardless of how many files are also in the set), navigate into that folder; (d) else highlight the first filtered entry (file or folder) — this is a highlight-only step and the visible highlight is the feedback; a subsequent `Enter` then re-enters this ladder and hits (a) or (b). Rule (b) is the only path that triggers the hint, so a filter that matches only files and is already highlighted on the first entry keeps yielding the hint on repeated `Enter`, never a silent no-op. The hint text is `Files can't be opened as a project`, shown in the footer for 2s before reverting. Chose the footer hint over an input shake/flash because it needs no animation infrastructure and the footer is already the dialog's status region.
  - `Esc` — if filter is non-empty, clear it and `stopPropagation` so the outer dialog doesn't close; otherwise let the event bubble and call `onCancel`.
- **Focus management:** the input retains focus across row clicks. Clicking a row calls `setSelectedName` but does not steal focus (`onMouseDown` with `preventDefault` on the row buttons, or explicit `inputRef.current?.focus()` after selection). This keeps arrow keys and typing working after the user mouses.
- **Navigation helper.** Introduce a `navigate(path)` wrapper that calls `loadDir(path)` *and* clears the filter. All user-initiated navigation (breadcrumb segment click, the breadcrumb `↑` parent-directory button, double-click, chevron click, `Enter`-to-enter-folder) goes through `navigate`. The `↑`/`↓` ArrowUp/ArrowDown *keys* move the filter-list highlight per the keyboard spec above and do not call `navigate`. The mount effect calls `loadDir(path)` directly — it never clears the filter, so a user who types before the first load completes does not lose their input. This removes the `didInitialLoad` ref.
- When the filter changes, if the current `selectedName` is no longer in the filtered list, clear it so the button label doesn't go stale.
- **Empty-state copy.** When `entries.length > 0` but `filteredEntries.length === 0`, render `No matches for '<filter>'` instead of the generic `Empty directory` copy — the latter is misleading when the directory has contents that are simply filtered out.
- Placeholder: `Type to filter…` with a leading `Search` icon (lucide) for scannability, matching the existing icon-prefixed inputs in the sidebar.

### 2. Dynamic button label (addresses complaint #3)

Replace the static "Select" label with the path it will return:

- When a row is highlighted: `Select /home/neil/myproject`
- When no row is highlighted: `Select /home/neil` (the current directory)
- **Left-ellipsis truncation.** Plain Tailwind `truncate` right-ellipsizes, which hides the meaningful tail. Use `direction: rtl; text-align: left;` on an inner span wrapping the path (keep the word "Select" in a separate LTR span), or equivalent CSS. Add the full path as a `title` attribute for hover-tooltip verification. Note: RTL-directionality on the path span can reorder punctuation in filenames that themselves contain RTL characters — accepted as a tiny edge-case risk for SSH target paths.

This makes the two selection modes (child vs. current dir) visible without any model change, and tells the user exactly what will be opened.

### 3. Footer

Keep the existing muted full-path line — it's the unambiguous source of truth when the button label is ellipsized. Prepend a short hint so first-time users know what Select does:

> Opens as a remote project · `/home/neil/myproject`

Single line, muted, truncates with right-ellipsis (the prefix is the fixed part, the path tail can be cut since it's already in the button's `title`).

When `Enter` is pressed on a highlighted file, swap this line for `Files can't be opened as a project` (same muted style) for 2s, then revert. Clear the hint's timer eagerly on any filter change or navigation so the message never outlives the state it describes.

### 4. Folder-row chevron (addresses complaint #2)

Folder rows render a `›` icon (lucide `ChevronRight`) on the right edge, shown only on row hover or keyboard focus. Files never render the chevron.

- **Trigger:** CSS `:hover` on the row plus a `:focus-visible` rule so keyboard-focused rows also show it. Never always-visible — a permanent chevron is visual noise across a long list.
- **Click handler:** the chevron is a nested `<button>` with its own `onClick` that calls `navigate(entry.path)`. It must `stopPropagation` so the parent row's single-click-select handler doesn't also fire. Clicking the chevron is equivalent to double-clicking the row.
- **a11y:** `aria-label="Open <name>"`. Reachable via Tab when the row is focused; `Enter`/`Space` on the focused chevron navigates into the folder. Screen readers announce the label distinctly from the row's select action.
- **Hit target:** ≥ 24px square, padded inside the row so touchpad taps land reliably.

## What is NOT changing

- **Selection model** — single-click highlights, double-click navigates. Finder/Explorer conventions preserved.
- **Breadcrumb bar** — already good; nicer than VS Code's path-in-input approach.
- **Non-git-folder handling** — `AddRepoSteps.tsx` lines 108–117 still opens the `confirm-non-git-folder` modal on `Not a valid git repository`. Out of scope.

## Tests

Add a co-located test file (following the pattern of `smart-sort.test.ts` etc. in the same directory). Minimum coverage:

- Filter substring-matches case-insensitively across files and folders.
- `Enter` with a single folder match navigates into it.
- `Enter` with multiple matches and no highlight highlights the first filtered entry.
- `Enter` on a highlighted file surfaces the transient footer hint (`Files can't be opened as a project`) and does not navigate.
- `Esc` with a non-empty filter clears it and does not call `onCancel`; `Esc` with empty filter calls `onCancel`.
- `selectedName` is cleared when the filter change removes it from the visible list.
- Filter is *not* cleared by the initial mount load; *is* cleared by a subsequent `navigate(path)` call.
- **Path equivalence:** navigating into `foo` (via chevron/double-click/`Enter`) then pressing `Select` returns the same `onSelect` path as highlighting `foo` from its parent and pressing `Select`.
- Clicking a folder row's chevron navigates into the folder and does not leave the row merely highlighted (i.e. chevron click is not swallowed by the row's select handler).
- Empty-state copy: with a non-empty directory and a filter that matches nothing, the list shows `No matches for '<filter>'`, not `Empty directory`.

## Files to change

- `src/renderer/src/components/sidebar/RemoteFileBrowser.tsx` — all UI changes live here (filter input, `navigate` wrapper, chevron on folder rows, footer hint state, empty-state copy).
- `src/renderer/src/components/sidebar/RemoteFileBrowser.test.tsx` — new.
- No IPC, main-process, or `AddRepoSteps.tsx` changes required.

## Follow-ups (not this PR)

- **State bloat.** The component will accumulate several pieces of local state (`entries`, `selectedName`, `filter`, `resolvedPath`, transient footer-hint flag, loading/error). Consider consolidating into a `useReducer` in a later pass; leaving as discrete `useState` hooks for this PR to keep the diff reviewable.
