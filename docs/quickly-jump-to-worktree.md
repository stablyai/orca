# Design Document: Quick Jump to Worktree (Issue #426)

## 1. Overview

As Orca scales to support multiple parallel agents and tasks, users frequently need to switch between dozens of active worktrees. Navigating via the sidebar becomes inefficient at scale.

This document outlines the design for a "Quick Jump to Worktree" feature: a globally accessible Command Palette-style dialog that allows users to search across all their active worktrees by name, repository, comment, PR metadata, and issue metadata, and jump to them instantly. This feature is intended to be the central, beating heart of navigation within Orca.

## 2. User Experience (UX)

### 2.1 The Shortcut: `Cmd+J` (macOS) / `Ctrl+Shift+J` (Windows/Linux)

To establish this palette as the central "Switch Worktree" action in Orca, `**Cmd+J**` (macOS) and `**Ctrl+Shift+J**` (Windows/Linux) are the chosen shortcuts.

**Why `Cmd+J` / `Ctrl+Shift+J`?**

- **Matches the action honestly:** This palette switches between existing worktrees. "Jump" is a better semantic fit than "Open" because the user is navigating, not creating a new file-open flow.
- **Avoids `Ctrl+J` (Line Feed) conflict:** On Windows and Linux, `Ctrl+J` translates to a Line Feed (`\n`) in bash, zsh, and almost all readline-based CLI applications. For many terminal power users, `Ctrl+J` and `Ctrl+M` (Carriage Return) are used interchangeably with the physical `Enter` key to execute commands. In Vim, it is used for navigation or inserting newlines, and in Emacs it maps to `newline-and-indent`. Intercepting `Ctrl+J` globally would severely disrupt core terminal workflows. Thus, `Ctrl+Shift+J` is used on these platforms. (On macOS, `Cmd` is an OS-level modifier, so `Cmd+J` safely avoids this issue).
- **Avoids `Cmd+K` conflict:** In terminal-heavy apps, `Cmd+K` is universally expected to "Clear Terminal". Overriding it breaks developer muscle memory.
- **Avoids `Cmd+P` conflict:** `Cmd+P` is already in use for Quick Open File (`QuickOpen.tsx`).
- **Avoids `Ctrl+E` (readline):** `Ctrl+E` is "end of line" in bash/zsh readline. Stealing it in a terminal-heavy app would break shell navigation muscle memory — the same class of conflict that rules out `Cmd+K`.
- **Discoverability:** The shortcut should be registered in the Electron Application Menu (e.g., `View -> Open Worktree Palette`) so users can discover it visually.

### 2.2 The Interface

When the shortcut is pressed, a modal dialog appears at the center top of the screen (similar to VS Code's palette or Spotlight).

- **Input:** A text input focused automatically.
- **List:** A scrollable list of worktrees, constrained to `max-h-[min(400px,60vh)]` to prevent the palette from overflowing the viewport when many worktrees are present.
- **Default state (empty query):** When the palette opens with no query, the full list of non-archived worktrees is shown in recent-sort order. The data source is `worktreesByRepo`, filtered by `!w.isArchived` (same filter applied by `computeVisibleWorktreeIds` in `visible-worktrees.ts`). The palette intentionally ignores the sidebar's `showActiveOnly` and `filterRepoIds` filters — it is a global jump tool, not a filtered view. No truncation — the list is scrollable and the expected count (&lt;200) does not require pagination.
- **Sorting (Recent Semantics):** The palette **always** uses `recent` sort order regardless of the sidebar's current `sortBy` setting. Alphabetical or repo-grouped sort would be a poor default for a "jump to" palette — recency is what the user almost always wants. Internally, this means calling `buildWorktreeComparator` from `smart-sort.ts` with `sortBy: 'recent'`. This gives the same smart-sort signals as the sidebar in recent mode: active agent work, permission-needed state, unread state, live terminals, PR signal, linked issue, and recency (`lastActivityAt`), with the same cold-start fallback to persisted `sortOrder` until live PTY state is available (see the `!hasAnyLivePty` branch in `getVisibleWorktreeIds()`).
- **Visual Hierarchy &amp; Highlights:** Because search covers multiple fields simultaneously, the list items must visually clarify *why* a result matched. If the match is inside a comment, display a truncated snippet of that comment centered around the matched range, with the matching text highlighted.
- **Multi-repo disambiguation:** Each list item always displays the repository name (e.g., `stablyai/orca`) alongside the worktree name. This is required because the palette spans all repos — without it, two worktrees named "main" from different repos would be indistinguishable.
- **Empty State:** Two cases: (1) If the user has 0 non-archived worktrees, display "No active worktrees. Create one to get started." (2) If worktrees exist but none match the search query, display "No worktrees match your search." Both use `<Command.Empty>`.
- **Search fields:** The search input will match against:
  - Worktree `displayName`
  - Worktree `branch`, normalized via `branchName()` to strip the `refs/heads/` prefix (e.g., `refs/heads/feature/auth-fix` → `feature/auth-fix`)
  - Repository name (e.g., `stablyai/orca`)
  - Full `comment` text attached to the worktree
  - Linked PR number/title. Two paths: (a) auto-detected PR via `prCache` (cache key: `${repo.path}::${branch}`), which has both number and title; (b) manual `linkedPR` fallback, which has number only (no title to search against). If `prCache` has a hit, prefer it; otherwise fall back to `linkedPR` number matching.
  - Linked issue number/title. The issue number comes from `w.linkedIssue`; the title comes from `issueCache` (cache key: `${repo.path}::${w.linkedIssue}`). Number matching works even without a cache hit; title matching requires the cache entry to be populated.
  - **Cache freshness caveat:** PR and issue data is populated by `refreshGitHubForWorktree`, which runs on worktree activation, and by `refreshAllGitHub`, which runs on window re-focus (`visibilitychange`). On startup, `initGitHubCache` loads previously persisted PR/issue data from disk, so worktrees fetched in prior sessions start with warm caches. Worktrees that have never been activated, were not covered by a `refreshAllGitHub` pass, and have no persisted cache entry will have empty caches — PR/issue title search will silently miss them. This is acceptable: the gap is limited to brand-new worktrees between creation and the next activation or window re-focus cycle. Number-based matching (e.g., `#304`) always works because it checks `w.linkedPR` / `w.linkedIssue` directly, without the cache.
  - `**#`-prefix handling:** A leading `#` in the query is stripped before matching PR/issue numbers (e.g., `#304` matches number `304`), with a guard against bare `#` which would produce an empty string and match everything. This mirrors the existing `matchesSearch()` behavior.
- **Navigation:** `Up` / `Down` arrows to navigate the list, `Enter` to select. `Escape` closes the modal.

## 3. Technical Architecture

### 3.1 UI Components

Orca uses `shadcn/ui`. We will add the **Command** component, which wraps the `cmdk` library.

**New dependency:** `cmdk` (~4KB gzipped) will be added as a direct dependency in `package.json`. It is already present in `node_modules` as a transitive dependency, but not directly importable.

```bash
pnpm dlx shadcn@latest add command
```

Note: `dialog.tsx` already exists in `src/renderer/src/components/ui/`. The shadcn `CommandDialog` uses Radix Dialog internally; verify it shares the same Radix instance to avoid duplicate bundles. If the installed `cmdk` version pins a different `@radix-ui/react-dialog` than the existing `dialog.tsx`, align `dialog.tsx` to the shadcn-installed version to prevent a double-bundled Radix.

**z-index:** The `CommandDialog` must use `z-50` or higher to reliably overlay the terminal and sidebar, consistent with `QuickOpen.tsx` which uses `z-50` on its fixed overlay container.

- `**WorktreeJumpPalette.tsx`:** A new component mounted at the root of the app (inside `App.tsx`, alongside the existing `<QuickOpen />`) to ensure it can be summoned from anywhere.
- `**CommandDialog`:** The shadcn component used to render the modal.

### 3.2 Keyboard Shortcut

The shortcut follows the **same renderer-side `keydown` pattern** already used by `Cmd+P` (QuickOpen) and `Cmd+1–9` (worktree jump) in `App.tsx`.

The existing `onKeyDown` handler in `App.tsx` (inside a `useEffect`) has two zones: shortcuts registered **before** the `isEditableTarget` guard fire from any focus context including xterm.js and contentEditable elements; shortcuts **after** the guard only fire from non-editable targets. `Cmd+P` and `Cmd+1–9` are in the pre-guard zone. `Cmd+J` must also be placed there so it works when a terminal has focus — no main-process `before-input-event` interception is needed.

**Implementation:** Add a new branch to the existing `onKeyDown` handler in `App.tsx`, before the `isEditableTarget` guard:

```tsx
// Cmd/Ctrl+J — toggle worktree jump palette
if (mod && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'j') {
  e.preventDefault()
  if (worktreePaletteVisible) {
    setWorktreePaletteVisible(false)
  } else {
    closeModal()
    setQuickOpenVisible(false)
    setWorktreePaletteVisible(true)
  }
  return
}
```

**Toggle semantics:** If the palette is already open, `Cmd+J` closes it (matching the toggle behavior users expect from palette shortcuts). The overlay mutual-exclusion clearing (`closeModal`, `setQuickOpenVisible(false)`) only runs on open, not on close.

**No `activeWorktreeId` or `activeView` guard:** Unlike `Cmd+P` (which requires both `activeView !== 'settings'` and `activeWorktreeId !== null`), the palette has neither guard. Users should be able to open the palette even when no worktree is active (e.g., fresh session with repos but no worktree selected yet) or from the settings view. The escape/cancel path must handle `previousWorktreeId === null` gracefully — focus falls to the document body.

**Overlay mutual exclusion:** The codebase has three independent overlay state systems: `activeModal` (union type in `ui.ts`), `quickOpenVisible` (boolean in `editor.ts`), and the new `worktreePaletteVisible` (boolean in `ui.ts`). All three must be mutually exclusive — only one overlay can be open at a time. The mechanism:

1. `**Cmd+J` handler** (palette open): Before setting `worktreePaletteVisible(true)`, call `closeModal()` (dismisses any active modal) and `setQuickOpenVisible(false)` (dismisses QuickOpen).
2. `**Cmd+P` handler** (QuickOpen open): Before setting `quickOpenVisible(true)`, call `setWorktreePaletteVisible(false)`. (It already calls `closeModal()` implicitly by not conflicting with the modal system.)
3. `**openModal()` wrapper**: Extend `openModal` in `ui.ts` to also call `setWorktreePaletteVisible(false)` when opening a modal. This covers all modal-open paths (Cmd+N, delete confirmation, etc.) without requiring each callsite to know about the palette. `quickOpenVisible` lives in the editor slice, so `openModal` cannot directly clear it from within the UI slice. This is safe because of how QuickOpen's focus model works: QuickOpen auto-focuses its `<input>` on mount (via `requestAnimationFrame` in a `useEffect`), and `isEditableTarget` returns `true` for `<input>` elements. Therefore, all keyboard-triggered `openModal` paths (`Cmd+N`, etc.) that are gated behind `isEditableTarget` will not fire while QuickOpen has focus. Mouse-triggered `openModal` paths (e.g., `WorktreeCard` double-click calling `openModal('edit-meta')`) fire on the sidebar, which is visually behind the QuickOpen overlay — the click would first dismiss QuickOpen via its backdrop `onClick` handler, closing it before the modal opens.

This prevents z-index stacking and confusing multi-overlay states.

**Tech debt note:** Three independent overlay state systems (`activeModal`, `quickOpenVisible`, `worktreePaletteVisible`) is O(n²) in the number of overlay types — every new overlay must know about all others. A follow-up issue should be filed to unify them into a single `activeOverlay` union type, but this is out of scope for the current feature.

**Menu registration:** Register a `View -> Open Worktree Palette` entry in `register-app-menu.ts` for discoverability, consistent with Section 2.1. The entry must use a **display-only shortcut hint** — do **not** set `accelerator: 'CmdOrCtrl+J'`. In Electron, menu accelerators intercept key events at the main-process level *before* the renderer's `keydown` handler fires (this is how `CmdOrCtrl+,` for Settings works — its `click` handler runs in the main process via `onOpenSettings`). If `CmdOrCtrl+J` were registered as a real accelerator, the renderer `keydown` handler would never see the event, and the overlay mutual-exclusion logic (which runs in the renderer) would be bypassed. Instead, show the shortcut text in the menu label (e.g., `label: 'Open Worktree Palette\tCmdOrCtrl+J'`) without binding `accelerator`, matching the pattern used by `Cmd+P` (QuickOpen), which has no menu entry at all and relies solely on the renderer handler.

### 3.3 State Management

- **Visibility state:** Add `worktreePaletteVisible: boolean` and `setWorktreePaletteVisible: (v: boolean) => void` to the UI slice (`store/slices/ui.ts`). Note: the existing `quickOpenVisible` lives in the editor slice, not UI. The palette visibility belongs in UI because it is a global navigation concern, not editor-specific state.
- **Palette session state:** `query` and `selectedIndex` are ephemeral to the palette component and should live in React component state (not Zustand). They reset on every open.
- **Render optimization:** When `worktreePaletteVisible === false`, the `<CommandDialog>` should not render its children. The shadcn `CommandDialog` unmounts content when `open={false}` by default, which is sufficient.
- **Recent-sort ordering:** Always use `recent` sort regardless of the sidebar's `sortBy` setting. The cold/warm branching logic currently lives in the fallback path of `getVisibleWorktreeIds()` in `visible-worktrees.ts`: it checks `hasAnyLivePty` from `tabsByWorktree`, and if cold-start (no live PTYs yet), falls back to persisted `sortOrder` descending with alphabetical `displayName` fallback; otherwise it calls `buildWorktreeComparator('recent', ...)`. Note: `getVisibleWorktreeIds()` is only the Cmd+1–9 fallback — the primary sidebar sort happens inside `WorktreeList`'s render pipeline via `sortEpoch`. To avoid duplicating the cold/warm branching in the palette, extract a `sortWorktreesRecent(worktrees, tabsByWorktree, repoMap, prCache)` helper in `smart-sort.ts` that encapsulates the cold/warm detection and returns the sorted array. Both the `getVisibleWorktreeIds()` fallback path and the palette import this shared helper.

### 3.4 Data Layer &amp; Search

The palette needs access to all worktrees known to Orca.

- **Data source:** Read from the existing `worktreesByRepo` in Zustand (already populated via `fetchAllWorktrees` on startup and kept in sync via IPC push events). No new IPC channel is needed. Filter out archived worktrees (`!w.isArchived`) before searching or displaying. Do **not** apply the sidebar's `showActiveOnly` or `filterRepoIds` filters — the palette is a global jump tool that surfaces all non-archived worktrees regardless of the sidebar's filter state. Because the palette reads directly from `worktreesByRepo`, it reactively updates if a worktree is created or deleted via IPC push while the palette is open — no special stale-list handling is needed.

#### Search implementation

The sidebar already has a `matchesSearch()` function in `worktree-list-groups.ts` that does **substring matching** (`includes(q)`) against displayName, branch, repo, comment, PR, and issue fields. The palette search builds on this foundation but extends it. Note: `branchName()` (used to strip `refs/heads/` prefixes) is currently exported from `worktree-list-groups.ts` — a sidebar-specific module that imports Lucide icons (`CircleCheckBig`, `CircleDot`, etc.) at the top level. Importing `branchName` from it would pull the entire module (including unused icon components) into the palette's bundle. `smart-sort.ts` has its own duplicate: `branchDisplayName()` doing the identical `branch.replace(/^refs\/heads\//, '')`. Extract `branchName()` to a shared utility (`lib/git-utils.ts`) in Phase 1, and update `worktree-list-groups.ts` and `smart-sort.ts` to import from there. This is a 3-line function — the extraction is trivial and avoids the bundle bloat.

1. **Matching strategy: substring, not fuzzy.** Use the same case-insensitive substring matching as `matchesSearch()`. True fuzzy matching (ordered-character, like `QuickOpen.tsx`'s `fuzzyMatch`) is not appropriate here — worktree names and comments are short enough that substring search provides good recall without false positives.
2. **Structured match metadata:** Unlike `matchesSearch()` (which returns `boolean`), the palette search helper returns a result object:

```ts
type MatchRange = { start: number; end: number }

type PaletteMatchBase = { worktreeId: string }

/** Empty query — all non-archived worktrees shown, no match metadata. */
type PaletteMatchAll = PaletteMatchBase & {
  matchedField: null
  matchRange: null
}

/** Comment match — includes a truncated snippet centered on the matched range. */
type PaletteMatchComment = PaletteMatchBase & {
  matchedField: 'comment'
  matchRange: MatchRange
  snippet: string
}

/** Non-comment field match — range within the matched field's display value. */
type PaletteMatchField = PaletteMatchBase & {
  matchedField: 'displayName' | 'branch' | 'repo' | 'pr' | 'issue'
  matchRange: MatchRange
}

type PaletteMatch = PaletteMatchAll | PaletteMatchComment | PaletteMatchField
```

3. **Field priority order:** When multiple fields match, report the first match by priority: `displayName` &gt; `branch` &gt; `repo` &gt; `comment` &gt; `pr` &gt; `issue`. This determines which badge/highlight is shown.
4. **Comment snippet extraction:** Search against the full `comment` text. Only the *rendered snippet* is truncated — extract ~80 characters of surrounding context centered on the matched range. Clamping: `snippetStart = Math.max(0, matchStart - 40)`, `snippetEnd = Math.min(comment.length, matchEnd + 40)`. After clamping, snap to word boundaries: scan `snippetStart` backward (up to 10 chars) to the nearest whitespace or string start; scan `snippetEnd` forward (up to 10 chars) to the nearest whitespace or string end. This avoids cutting words mid-character (e.g., `…e implementation of th…` → `…the implementation of the…`). Prepend `…` if `snippetStart > 0`; append `…` if `snippetEnd < comment.length`.
5. `**cmdk` wiring:** Render with `shouldFilter={false}` so the palette controls filtering. Pass only the filtered result set to `<Command.Item>`:

```tsx
<Command.Item
  key={worktree.id}
  value={worktree.id}
  onSelect={() => handleSelectWorktree(worktree.id)}
>
  {/* Render worktree row with match badge + highlighted range */}
</Command.Item>
```

6. **Performance:** Keep `value` compact (`worktree.id`) and do not stuff full comments into `keywords`. For the expected worktree count (&lt;200), synchronous filtering on every keystroke is fast enough — no debounce is needed. If worktree counts exceed 500 or filter times exceed 16ms (one frame), add list virtualization via `@tanstack/react-virtual` (already a project dependency). The search contract (`PaletteMatch[]` in, `<Command.Item>` out) does not change either way.

### 3.5 Action (Worktree Activation)

#### Existing callsite analysis

The codebase has several worktree activation paths with inconsistent step coverage:


| Step                                 | `WorktreeCard` click | `Cmd+1–9` | `AddRepoDialog` | `AddWorktreeDialog` |
| ------------------------------------ | -------------------- | --------- | --------------- | ------------------- |
| Set `activeRepoId`                   | No                   | No        | Yes             | Yes                 |
| Set `activeView`                     | No                   | No        | Yes             | Yes                 |
| `setActiveWorktree()`                | Yes                  | Yes       | Yes             | Yes                 |
| `ensureWorktreeHasInitialTerminal()` | No                   | No        | Yes             | Yes                 |
| `revealWorktreeInSidebar()`          | No                   | Yes       | Yes             | Yes                 |


Sidebar card clicks and `Cmd+1–9` work without setting `activeRepoId` because `activeRepoId` is only consumed by the "Create Worktree" dialog (to pre-select a repo) and session persistence — it does not gate rendering or data fetching for the switched-to worktree. Similarly, `ensureWorktreeHasInitialTerminal` is only needed for newly created worktrees that have never been opened; existing worktrees already have terminal tabs.

#### Palette activation sequence

The palette should match what `Cmd+1–9` does today (the closest analog: jumping to a visible worktree from any context), plus a few extras justified by the palette's cross-repo scope:

1. **Set `activeRepoId`:** If the target worktree's `repoId` differs from the current `activeRepoId`, call `setActiveRepo(repoId)`. This keeps session persistence and the "Create Worktree" repo pre-selection accurate. Sidebar clicks skip this because they operate within a single repo group; the palette does not have that constraint.
2. **Switch `activeView`:** If `activeView` is `'settings'`, set it to `'terminal'` so the main content area renders the worktree surface. `Cmd+1–9` does not handle this because it refuses to fire at all from the settings view (gated on `activeView !== 'settings'` in the `onKeyDown` handler); the palette intentionally has no such guard so users can jump to a worktree directly from settings.
3. **Call `setActiveWorktree(worktreeId)`:** This runs Orca's existing activation sequence: sets `activeWorktreeId`, restores per-worktree editor state (`activeFileId`, `activeTabType`, `activeBrowserTabId`), restores the last-active terminal tab, clears unread state, bumps dead PTY generations, and triggers `refreshGitHubForWorktree` to ensure PR/issue/checks data is current for the newly active worktree.
4. **Ensure a focusable surface:** If the worktree has no terminal tabs (i.e., `tabsByWorktree[worktreeId]` is empty), call `ensureWorktreeHasInitialTerminal` (`worktree-activation.ts`). This handles worktrees that were created externally (e.g., via CLI or IPC push) and never opened in the UI. The function already no-ops when tabs exist, so the guard is `existingTabs.length > 0` inside the function itself.
5. **Reveal in sidebar:** Call `revealWorktreeInSidebar(worktreeId)` to ensure the selected worktree is visible (handles collapsed groups and scroll position).
6. **Close the palette.**

#### Shared helper

The five activation steps above overlap heavily with `AddRepoDialog.handleOpenWorktree` and `AddWorktreeDialog`'s post-create flow. With three callsites now sharing the same core sequence, extract a shared `activateAndRevealWorktree(worktreeId: string, opts?: { setup?: WorktreeSetupLaunch })` helper in `worktree-activation.ts` that covers the common steps: set `activeRepoId` (cross-repo), switch `activeView` (from settings), `setActiveWorktree`, `ensureWorktreeHasInitialTerminal`, clear sidebar filters that would hide the target, and `revealWorktreeInSidebar`.

**Sidebar filter clearing:** The helper must clear any sidebar filter state that would prevent the target card from being rendered, because `revealWorktreeInSidebar` relies on the worktree card being *rendered* in the sidebar (the `pendingRevealWorktreeId` effect in `WorktreeList` finds the target in the rendered `rows` array via `findIndex`). If sidebar filters exclude the target, the card is never rendered and the reveal silently no-ops — the user selects a worktree and nothing visually happens. `AddWorktreeDialog` already handles this inline (clears both `searchQuery` and `filterRepoIds` before activation); the shared helper absorbs that responsibility. Specifically:

- Clear `filterRepoIds` if it is non-empty and does not include the target worktree's repo.
- Clear `searchQuery` unconditionally if it is non-empty. Even if the target repo is visible, an active text search might exclude the specific worktree being jumped to.

Callsite-specific extras that remain inline after calling the shared helper:

- `**AddWorktreeDialog`:** `setSidebarOpen(true)`, open right sidebar if `rightSidebarOpenByDefault`.
- `**AddRepoDialog`:** `closeModal()` (the palette closes itself separately).
- **Palette:** close the palette, focus management (Section 3.5 Focus management).

The helper derives `repoId` internally via `findWorktreeById(worktreesByRepo, worktreeId)` (`worktree-helpers.ts:45`) — the caller only passes `worktreeId`. If the worktree is not found (e.g., deleted between palette open and select), the helper returns early without side effects.

#### Focus management (v1 — simple strategy)

- **On select:** After closing the palette, use a double `requestAnimationFrame` (nested rAF) to focus the active surface (terminal xterm instance or Monaco editor) for the target worktree. The first rAF waits for React to commit the state change (palette closes); the second waits for the target worktree's surface layout to settle after Radix Dialog unmounts. Use `onCloseAutoFocus` on the `CommandDialog` with `e.preventDefault()` to prevent Radix from stealing focus to the trigger element. **Fragility note:** the double-rAF is a pragmatic v1 choice — it assumes Radix unmounts within two frames, which depends on the CSS transition duration and reduced-motion settings. If this proves unreliable, replace with a short `setTimeout` matching the actual animation duration or listen for the dialog's `onAnimationEnd`.
- **On escape:** Same double-rAF approach, but focus the active surface for the *current* worktree (the one that was active before the palette opened). Track `previousWorktreeId` as a ref inside the component. If `previousWorktreeId` is `null` (no worktree was active when the palette opened), skip the focus call — focus falls to the document body.
- **Degradation:** If the target surface is not mounted in time (e.g., cold worktree that was created externally and has never been opened — its terminal is still spawning after `ensureWorktreeHasInitialTerminal`), the focus call silently no-ops and focus falls to the document body. The user can click to focus. This is the **common case for externally-created worktrees**, not just a rare edge case — but it is acceptable for v1 because the worktree content still renders correctly; only auto-focus is lost.
- **Future improvement:** A full `focusReturnTarget` system that records the exact xterm/editor/UI element and a `pendingFocus` state for async mount scenarios. This is deferred because the codebase has no existing focus-tracking infrastructure and the simple strategy covers the common case.

### 3.6 Accessibility

The `cmdk` library provides built-in ARIA support:

- `role="combobox"` on the input
- `role="listbox"` / `role="option"` on the list and items
- `aria-activedescendant` for keyboard navigation
- `aria-expanded` on the dialog

**Additional requirements:**

- Announce filtered result count changes to screen readers via an `aria-live="polite"` region (e.g., "3 worktrees found").
- Match-field badges (e.g., `Branch`, `Comment`) should include `aria-label` text so screen readers convey why the result matched.

## 4. Implementation Phases

**Phase 1: Component, Shortcut &amp; Data**

- Add `cmdk` via `pnpm dlx shadcn@latest add command`.
- Extract `branchName()` to `lib/git-utils.ts`; update imports in `worktree-list-groups.ts` and `smart-sort.ts` (consolidating the duplicate `branchDisplayName()`).
- Extract `sortWorktreesRecent()` helper in `smart-sort.ts` (encapsulates cold/warm branching from `getVisibleWorktreeIds()`); update `getVisibleWorktreeIds()` to use it.
- Create `WorktreeJumpPalette.tsx`, mount in `App.tsx`.
- Add `worktreePaletteVisible` to the UI slice.
- Add `Cmd/Ctrl+J` toggle handler to the existing `onKeyDown` in `App.tsx`.
- Wire real worktree data from `worktreesByRepo` (filtered by `!isArchived`) with sidebar-consistent recent ordering and both empty states (no worktrees / no search results).
- Handle startup race: if `worktreesByRepo` is empty but repos exist (data still loading), show a "Loading worktrees..." state instead of the misleading "No active worktrees" empty state. Guard: `Object.keys(worktreesByRepo).length === 0 && repos.length > 0`. Note: `worktreesByRepo` is populated per-repo as individual `fetchWorktrees` calls complete, so once any repo's worktrees arrive, the guard flips to showing partial results — this is intentional (partial results are more useful than a spinner) but means the list may grow incrementally during the first few seconds after launch.
- Define and implement the search result model: `PaletteMatch` with matched field, character ranges, and comment snippet extraction.
- Render with `shouldFilter={false}` and the manual search helper.
- Visual baseline: follow shadcn `CommandDialog` defaults. Use the same palette width as `QuickOpen.tsx` (`w-[660px] max-w-[90vw]`). Item rows show worktree name, repo label, and a muted match-field badge. Active/highlighted item uses `bg-accent`. Detailed visual polish (match highlighting, snippet rendering) is deferred to Phase 3.

**Phase 2: Activation &amp; Focus**

- Extract `activateAndRevealWorktree` shared helper in `worktree-activation.ts` per Section 3.5.
- Wire the palette to use the shared helper. Refactor `AddRepoDialog` and `AddWorktreeDialog` to use it as well.
- Defensive select handler: before activating, verify the target worktree still exists in `worktreesByRepo`. If deleted between palette open and selection, show a toast and no-op instead of setting `activeWorktreeId` to a stale ID.
- Implement v1 focus management (`requestAnimationFrame` + `onCloseAutoFocus` prevention).
- Handle escape/cancel with `previousWorktreeId` ref.
- Register display-only `View -> Open Worktree Palette` menu entry (shortcut hint in label, no `accelerator` binding) per Section 3.2.

**Phase 3: Polish**

- Accessibility: `aria-live` result count announcements, badge `aria-label` text.
- Visual polish: match highlighting, comment snippet rendering, field badges.

**Future work (out of scope)**

- Evaluate migrating `QuickOpen.tsx` (currently a custom overlay with manual keyboard handling) to `cmdk`/`CommandDialog` for visual and behavioral consistency with the palette. This is a separate project — `QuickOpen` has its own fuzzy matching, file-loading, and keyboard handling that would need reworking.
- Unify the three overlay state systems (`activeModal`, `quickOpenVisible`, `worktreePaletteVisible`) into a single `activeOverlay` union type (see tech debt note in Section 3.2).

## 5. Alternatives Considered

- `**Cmd+O` (Open):** Standard app semantic, but less honest for this feature because the palette switches between existing worktrees rather than opening a new file or workspace. Rejected in favor of `Cmd+J`, which better matches the action users are taking.
- `**Ctrl+E` (Explore):** Initially considered for Windows/Linux. Rejected because `Ctrl+E` is "end of line" in bash/zsh readline — stealing it in a terminal-heavy app breaks shell navigation muscle memory.
- `**Ctrl+Alt+O`:** Initially considered for Windows/Linux but rejected to avoid `AltGr` collisions on international keyboards (e.g., Polish, German layouts).
- `**Cmd+1...9` (Direct jumping):** Doesn't scale past 9 worktrees and requires the user to memorize sidebar positions. Already implemented as a complementary feature.
- `**Cmd+K`:** Rejected due to conflict with "Clear Terminal".
- `**Cmd+P`:** Rejected because it is already used for file searching (`QuickOpen.tsx`).
- **Main-process `before-input-event` interception:** Initially proposed for the keyboard shortcut to bypass xterm focus. Rejected because the existing renderer-side `keydown` handler (used by `Cmd+P`, `Cmd+1–9`, etc.) already fires before the `isEditableTarget` guard and works from terminal focus. Adding main-process interception would require a new IPC channel and multi-window targeting logic for no benefit.

