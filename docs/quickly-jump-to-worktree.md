# Design Document: Quick Jump to Worktree (Issue #426)

## 1. Overview

As Orca scales to support multiple parallel agents and tasks, users frequently need to switch between dozens of active worktrees. Navigating via the sidebar becomes inefficient at scale.

This document describes the shipped "Quick Jump" palette in Orca: a globally accessible Command Palette-style dialog that lets users jump across active worktrees, open browser tabs that live inside worktrees, and create a new worktree from typed input. Search covers worktree metadata (name, branch, repo, comment, PR metadata, issue metadata) and browser metadata (page title, URL, worktree, repo).

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
- **List:** A scrollable list constrained to `max-h-[min(460px,62vh)]` to prevent the palette from overflowing the viewport when many results are present.
- **Default state (empty query):** When the palette opens with no query, the full list of non-archived worktrees is shown first, ordered by Orca's smart sort. If browser tabs also exist, they appear as a secondary section preview below the worktree list. The palette intentionally ignores the sidebar's `showActiveOnly` and `filterRepoIds` filters — it is a global jump tool, not a filtered view.
- **Sorting (Smart Semantics):** The palette uses Orca's smart worktree ordering via `sortWorktreesSmart(...)`, not plain recency. In practice this prioritizes active agent work, permission-needed state, unread state, live terminals, PR signal, linked issue, and recent activity, with a cold-start fallback to persisted `sortOrder` until any PTY is live.
- **Visual Hierarchy &amp; Highlights:** Because search covers multiple fields simultaneously, the list items must visually clarify *why* a result matched. If the match is inside a comment, display a truncated snippet of that comment centered around the matched range, with the matching text highlighted.
- **Multi-repo disambiguation:** Each list item always displays the repository name (e.g., `stablyai/orca`) alongside the worktree name. This is required because the palette spans all repos — without it, two worktrees named "main" from different repos would be indistinguishable.
- **Cross-surface scope:** The palette is not limited to worktrees. It also surfaces browser tabs, and when the user types a string that matches no worktree results it offers a "Create worktree" action using the current query.
- **Empty State:** Two cases: (1) If the user has no active worktrees and no browser tabs, display "No active worktrees or browser tabs". (2) If items exist but none match the search query, display "No results match your search." Both use `<Command.Empty>`.
- **Search fields:** The search input will match against:
  - Worktree `displayName`
  - Worktree `branch`, normalized via `branchName()` to strip the `refs/heads/` prefix (e.g., `refs/heads/feature/auth-fix` → `feature/auth-fix`)
  - Repository name (e.g., `stablyai/orca`)
  - Full `comment` text attached to the worktree
  - Linked PR number/title. Two paths: (a) auto-detected PR via `prCache` (cache key: `${repo.path}::${branch}`), which has both number and title; (b) manual `linkedPR` fallback, which has number only (no title to search against). If `prCache` has a hit, prefer it; otherwise fall back to `linkedPR` number matching.
  - Linked issue number/title. The issue number comes from `w.linkedIssue`; the title comes from `issueCache` (cache key: `${repo.path}::${w.linkedIssue}`). Number matching works even without a cache hit; title matching requires the cache entry to be populated.
  - **Cache freshness caveat:** PR and issue data is populated by `refreshGitHubForWorktree`, which runs on worktree activation, and by `refreshAllGitHub`, which runs on window re-focus (`visibilitychange`). On startup, `initGitHubCache` loads previously persisted PR/issue data from disk, so worktrees fetched in prior sessions start with warm caches. Worktrees that have never been activated, were not covered by a `refreshAllGitHub` pass, and have no persisted cache entry will have empty caches — PR/issue title search will silently miss them. This is acceptable: the gap is limited to brand-new worktrees between creation and the next activation or window re-focus cycle. Number-based matching (e.g., `#304`) always works because it checks `w.linkedPR` / `w.linkedIssue` directly, without the cache.
  - `**#`-prefix handling:** A leading `#` in the query is stripped before matching PR/issue numbers (e.g., `#304` matches number `304`), with a guard against bare `#` which would produce an empty string and match everything. This mirrors the existing `matchesSearch()` behavior.
- **Browser search fields:** Browser page title, URL/secondary text, worktree name, and repo name.
- **Navigation:** `Up` / `Down` arrows to navigate the list, `Enter` to select. `Escape` closes the modal.

## 3. Technical Architecture

### 3.1 UI Components

Orca uses `shadcn/ui` and ships the **Command** component, which wraps the `cmdk` library.

**Dependency:** `cmdk` is a direct dependency in `package.json`.

```bash
pnpm dlx shadcn@latest add command
```

Note: `CommandDialog` uses Radix Dialog internally. Orca keeps this inside the shared `components/ui/command.tsx` wrapper so both palettes use the same dialog primitives and styling hooks.

**z-index:** The `CommandDialog` must use `z-50` or higher to reliably overlay the terminal and sidebar, consistent with `QuickOpen.tsx` which uses `z-50` on its fixed overlay container.

- `**WorktreeJumpPalette.tsx`:** A new component mounted at the root of the app (inside `App.tsx`, alongside the existing `<QuickOpen />`) to ensure it can be summoned from anywhere.
- `**CommandDialog`:** The shadcn component used to render the modal.

### 3.2 Keyboard Shortcut

The shipped shortcut uses a **hybrid main-process + renderer architecture**:

1. The main window listens in `before-input-event` and resolves the chord through the shared window shortcut policy.
2. On `toggleWorktreePalette`, the main process sends `ui:toggleWorktreePalette` to the renderer.
3. The renderer toggles `activeModal === 'worktree-palette'` in `useIpcEvents.ts`.

This extra main-process hop is required because browser guests and other embedded Chromium surfaces can keep keyboard focus inside a guest `webContents`, bypassing the renderer's `window`-level `keydown` listener. A renderer-only implementation would fail from browser-tab focus.

**Toggle semantics:** If the palette is already open, the shortcut closes it; otherwise it opens it. There is no `activeWorktreeId` or `activeView` guard, so the palette is available from settings, from landing states with no active worktree, and from browser focus.

**Overlay mutual exclusion:** The current app models both Quick Open and the worktree palette inside the existing `activeModal` union in `ui.ts` (`'quick-open'` and `'worktree-palette'`). This keeps the two command palettes mutually exclusive without needing separate booleans.

**Menu registration:** Register a `View -> Open Worktree Palette` entry in `register-app-menu.ts` for discoverability, consistent with Section 2.1. The entry must use a **display-only shortcut hint** — do **not** set `accelerator: 'CmdOrCtrl+J'`. In Electron, menu accelerators intercept key events at the main-process level *before* the renderer's `keydown` handler fires (this is how `CmdOrCtrl+,` for Settings works — its `click` handler runs in the main process via `onOpenSettings`). If `CmdOrCtrl+J` were registered as a real accelerator, the renderer `keydown` handler would never see the event, and the overlay mutual-exclusion logic (which runs in the renderer) would be bypassed. Instead, show the shortcut text in the menu label (e.g., `label: 'Open Worktree Palette\tCmdOrCtrl+J'`) without binding `accelerator`, matching the pattern used by `Cmd+P` (QuickOpen), which has no menu entry at all and relies solely on the renderer handler.

### 3.3 State Management

- **Visibility state:** The palette is represented by `activeModal === 'worktree-palette'` in the UI slice. Quick Open similarly uses `activeModal === 'quick-open'`.
- **Palette session state:** `query` and `selectedIndex` are ephemeral to the palette component and should live in React component state (not Zustand). They reset on every open.
- **Render optimization:** When the modal is closed, `CommandDialog` unmounts its content, which is sufficient.
- **Ordering:** Worktree results are fed through `sortWorktreesSmart(...)`, and browser results are ordered relative to that same worktree ordering so both sections feel consistent.

### 3.4 Data Layer &amp; Search

The palette needs access to all worktrees known to Orca.

- **Data source:** Read from the existing `worktreesByRepo` in Zustand (already populated via `fetchAllWorktrees` on startup and kept in sync via IPC push events). No new IPC channel is needed. Filter out archived worktrees (`!w.isArchived`) before searching or displaying. Do **not** apply the sidebar's `showActiveOnly` or `filterRepoIds` filters — the palette is a global jump tool that surfaces all non-archived worktrees regardless of the sidebar's filter state. Because the palette reads directly from `worktreesByRepo`, it reactively updates if a worktree is created or deleted via IPC push while the palette is open — no special stale-list handling is needed.

#### Search implementation

The sidebar already has a `matchesSearch()` function in `worktree-list-groups.ts` that does **substring matching** (`includes(q)`) against displayName, branch, repo, comment, PR, and issue fields. The palette search builds on this foundation but extends it. Note: `branchName()` (used to strip `refs/heads/` prefixes) is currently exported from `worktree-list-groups.ts` — a sidebar-specific module that imports Lucide icons (`CircleCheckBig`, `CircleDot`, etc.) at the top level. Importing `branchName` from it would pull the entire module (including unused icon components) into the palette's bundle. `smart-sort.ts` has its own duplicate: `branchDisplayName()` doing the identical `branch.replace(/^refs\/heads\//, '')`. Extract `branchName()` to a shared utility (`lib/git-utils.ts`) in Phase 1, and update `worktree-list-groups.ts` and `smart-sort.ts` to import from there. This is a 3-line function — the extraction is trivial and avoids the bundle bloat.

1. **Matching strategy: substring, not fuzzy.** Use case-insensitive substring matching for worktrees and browser entries. True fuzzy matching (ordered-character, like `QuickOpen.tsx`'s `fuzzyMatch`) is not used here.
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

6. **Performance:** Keep `value` compact and do not stuff full comments into `keywords`. The current implementation debounces the query by 150ms before recomputing result sets. That keeps mixed worktree + browser searching cheap without materially hurting responsiveness at Orca's current scale.

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
4. **Ensure a focusable surface:** If the worktree has no renderable tabs, call `ensureWorktreeHasInitialTerminal` (`worktree-activation.ts`). The helper now decides this via the reconciled tab model, not by checking whether the legacy terminal-tab array is empty.
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

#### Focus management

- **On worktree select:** After closing the palette, use a double `requestAnimationFrame` (nested rAF) to focus the active terminal/editor surface for the target worktree. `onCloseAutoFocus` calls `preventDefault()` so Radix does not steal focus.
- **On browser-tab select:** Restore focus to the selected browser page, preferring the address bar for blank/new pages and the webview for loaded pages.
- **On escape/cancel:** Restore focus to the previously active browser page when the palette was opened from browser context; otherwise fall back to the terminal/editor surface for the previously active worktree. If no worktree was active, focus falls to the document body.

### 3.6 Accessibility

The `cmdk` library provides built-in ARIA support:

- `role="combobox"` on the input
- `role="listbox"` / `role="option"` on the list and items
- `aria-activedescendant` for keyboard navigation
- `aria-expanded` on the dialog

**Additional requirements:**

- Announce filtered result count changes to screen readers via an `aria-live="polite"` region (e.g., "3 worktrees found").
- Match-field badges (e.g., `Branch`, `Comment`) should include `aria-label` text so screen readers convey why the result matched.

## 4. Implementation Status

The core design is implemented:

- `cmdk` is a direct dependency and Orca ships a shared `CommandDialog`.
- `WorktreeJumpPalette.tsx` is mounted at the app root.
- The palette opens through main-process shortcut forwarding plus renderer IPC toggle handling.
- Worktree activation is routed through `activateAndRevealWorktree(...)`.
- Search supports comment snippets, PR/issue metadata, browser pages, and a create-worktree action.
- Menu discoverability is implemented with a display-only `View -> Open Worktree Palette` hint and no accelerator binding.

## 5. Remaining Gaps / Future Work

- Add broader integration coverage for the mixed worktree/browser palette behavior; current tests focus on search helper behavior and shortcut/menu plumbing.
- Evaluate whether the 150ms debounce should become adaptive if the palette eventually indexes substantially more browser pages.
- Consider unifying the worktree and browser result models further if future result types are added.

**Future work (out of scope)**

- Evaluate migrating `QuickOpen.tsx` (currently a custom overlay with manual keyboard handling) to `cmdk`/`CommandDialog` for visual and behavioral consistency with the palette. This is a separate project — `QuickOpen` has its own fuzzy matching, file-loading, and keyboard handling that would need reworking.
- Add richer end-to-end coverage for palette interactions launched from browser focus, including focus restoration after browser-tab selection and dismissal.

## 6. Alternatives Considered

- `**Cmd+O` (Open):** Standard app semantic, but less honest for this feature because the palette switches between existing worktrees rather than opening a new file or workspace. Rejected in favor of `Cmd+J`, which better matches the action users are taking.
- `**Ctrl+E` (Explore):** Initially considered for Windows/Linux. Rejected because `Ctrl+E` is "end of line" in bash/zsh readline — stealing it in a terminal-heavy app breaks shell navigation muscle memory.
- `**Ctrl+Alt+O`:** Initially considered for Windows/Linux but rejected to avoid `AltGr` collisions on international keyboards (e.g., Polish, German layouts).
- `**Cmd+1...9` (Direct jumping):** Doesn't scale past 9 worktrees and requires the user to memorize sidebar positions. Already implemented as a complementary feature.
- `**Cmd+K`:** Rejected due to conflict with "Clear Terminal".
- `**Cmd+P`:** Rejected because it is already used for file searching (`QuickOpen.tsx`).
- **Renderer-only shortcut handling:** Initially attractive because it mirrors simpler shortcuts, but rejected for the shipped palette. Browser guests can keep keyboard focus inside a separate `webContents`, so a renderer-only `window` listener would miss `Cmd+J` / `Ctrl+Shift+J` from browser-tab focus.
