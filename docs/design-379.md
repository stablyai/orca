# Design: Searchable Repository Selection in New Worktree Dialog

## 1. Problem Statement

GitHub issue [#379](https://github.com/stablyai/orca/issues/379): when creating a new worktree, the user must manually scroll a plain `Select` dropdown to pick the target repository. This does not scale once Orca manages many repositories.

The current Radix `Select` in `AddWorktreeDialog` has two product problems:

- It forces serial scanning instead of direct search.
- It makes the most important first step in the worktree-creation flow slower than every subsequent step.

The issue has no explicit acceptance criteria, so implementation requirements are inferred from the existing UX:

- Users must be able to search for a repository by name while creating a worktree.
- Existing auto-preselection behavior (preselectedRepoId, activeWorktreeRepoId, activeRepoId fallback chain) must keep working.
- Keyboard and mouse selection must both work.
- The change must not break the rest of the create-worktree flow: setup lookup, issue-command lookup, validation, and Enter-to-create behavior.

## 2. Approach

Replace the repository `Select` with a searchable combobox built from Orca's existing `Command` primitive (cmdk-based) and a new shared `Popover` primitive (Radix-based).

Rationale:

- A combobox is the standard pattern for "pick one item from a potentially long list, with search."
- Orca already ships `cmdk`-based command surfaces and Radix primitives, so this fits the existing stack without introducing new dependencies.
- Keeping the search scoped to the repo field preserves the current worktree-creation layout instead of turning the entire dialog into a command palette.
- Search logic lives in a pure helper (`searchRepos`) so matching rules are explicit and regression-testable outside React.

### Matching and ranking

- Search is case-insensitive substring matching.
- Primary target is `repo.displayName` (what issue #379 is specifically about). Secondary target is `repo.path` for disambiguating repos with similar display names.
- Ranking uses position-based scoring: matches earlier in the string rank higher. Display-name matches always outrank path-only matches (path scores are offset by 1000). Ties preserve original list order.
- Empty query returns the full eligible repo list in its original order.

## 3. Implementation Plan

### `src/renderer/src/components/ui/popover.tsx`

New shared Popover wrapper around Radix `Popover`. Follows the same styling conventions as existing `dialog.tsx`, `select.tsx`, and `dropdown-menu.tsx`. Generic and reusable — not inlined inside the worktree dialog.

### `src/renderer/src/lib/repo-search.ts`

New pure helper (`searchRepos`) that filters and ranks eligible repositories by a query string. Normalizes trimming and lowercasing in one place. Scoring logic:

- Display-name hit: score = index of substring match within `displayName`.
- Path-only hit: score = 1000 + index of substring match within `path`.
- No hit: excluded from results.
- Stable sort by `(score, originalIndex)` so equivalent matches preserve list order.

### `src/renderer/src/lib/repo-search.test.ts`

Unit tests covering:

- Empty query returns all repos in original order.
- Display-name matching is case-insensitive.
- Path fallback works when the display name does not match.
- Display-name matches rank ahead of path-only matches.

### `src/renderer/src/components/repo/RepoCombobox.tsx`

New reusable combobox component. Props: `repos`, `value`, `onValueChange`, optional `placeholder`.

Key design decisions:

- **External filtering**: `Command` is rendered with `shouldFilter={false}` because filtering is handled by `searchRepos`, not by cmdk's built-in filter. This keeps ranking rules in the pure helper where they are testable.
- **Trigger and content markup**: Both the trigger `Button` and `PopoverContent` carry `data-repo-combobox-root="true"` so the parent dialog's keydown handler can detect events originating inside the combobox surface (see Section 5).
- **Selected repo display**: The trigger renders the selected repo using the existing `RepoDotLabel` component, consistent with how repos appear elsewhere in Orca.
- **Result items**: Each item shows `RepoDotLabel` for the display name plus the full `repo.path` as secondary text, so repos with similar names are visually distinguishable.
- **Popover width**: `PopoverContent` uses `w-[var(--radix-popover-trigger-width)]` to match the trigger width for visual alignment.
- **Focus management**: `CommandInput` has `autoFocus` so the search input receives focus immediately when the popover opens.
- **Query reset on close**: `handleOpenChange` clears the query when the popover closes so stale filter text from a previous interaction does not hide repos on the next open.
- **Empty state**: `CommandEmpty` shows an explicit message when no repo matches.

### `src/renderer/src/components/sidebar/AddWorktreeDialog.tsx`

Changes to the existing dialog:

- Replace the `Select` repository control with `RepoCombobox`.
- All existing repo-selection state and side effects are preserved unchanged: `repoId`, `handleRepoChange`, auto-preselection on open, hook lookup, and issue-command lookup.
- Update the dialog-level `handleKeyDown` to suppress Enter when the event target lives inside a `[data-repo-combobox-root="true"]` element (see Section 5).

## 4. Edge Cases

| Scenario | Handling |
|---|---|
| No eligible git repos | Existing guard closes the dialog; the combobox is never rendered in a broken state. |
| Only one eligible repo | The combobox still renders normally. Search is trivial, but the UI stays consistent. |
| Multiple repos share a similar display name | Search also matches `repo.path`, and each item shows the full path as secondary text for disambiguation. |
| User opens combobox, types a query, closes, reopens | Query resets on close so the next open starts from the full list. |
| Enter pressed while focus is inside the repo search input | The dialog-level create shortcut is suppressed for events originating inside the combobox (see Section 5). |
| Preselected repo is not the first repo in the list | Auto-preselection logic is unchanged; the selected value is still controlled by `repoId` state. |
| Repo list changes while the dialog is open | The combobox renders from the live `eligibleRepos` array and updates reactively. If the selected repo disappears, existing dialog validation prevents create without a valid `selectedRepo`. |

## 5. Regressions and Mitigations

### Enter inside repo search creates a worktree

This is the most important correctness constraint. Without mitigation, typing a search query and pressing Enter to select a repo would bubble up to the dialog's keydown handler and trigger worktree creation.

Mitigation: `data-repo-combobox-root="true"` is placed on both the combobox trigger button and the popover content. The dialog's `handleKeyDown` checks `e.target.closest('[data-repo-combobox-root="true"]')` and returns early when it finds a match. This covers Enter events from:

- The `CommandInput` search field (inside the popover content).
- The trigger button itself when the popover is closed (Enter should open the popover, not submit the form).

An inline comment in `handleKeyDown` documents why this guard exists.

### Stale search query hides repos on reopen

Mitigation: `RepoCombobox.handleOpenChange` resets the query to `''` whenever the popover closes. An inline comment documents the timing interaction with the dialog's own delayed field reset.

### Repo preselection breaks

Mitigation: `repoId` remains the single source of truth for the selected repository. Only the presentation control was swapped; the state management and auto-selection logic in `AddWorktreeDialog` are untouched.

### Users cannot distinguish similarly named repos

Mitigation: Each combobox item shows both the `RepoDotLabel` display name and the full `repo.path` as secondary text.

### Matching behavior drifts over time

Mitigation: Search rules live in the pure `searchRepos` helper with dedicated unit tests, not inlined in JSX.

## 6. Test Plan

### Unit tests (`repo-search.test.ts`)

- Empty query returns all repos in original order.
- Display-name matching is case-insensitive.
- Path fallback works when the display name does not match.
- Display-name matches rank ahead of path-only matches.

### Manual verification

- Open the New Worktree dialog with multiple repos.
- Confirm the repo field opens a searchable combobox instead of a plain dropdown.
- Type part of a repo name and verify the list filters immediately.
- Press Enter to select a filtered repo and verify the dialog does not submit.
- Create a worktree after selecting a repo through search and verify the existing create flow still works end-to-end (setup, issue command, metadata).
- Reopen the dialog and verify the previous search text is cleared.
- Verify the preselected repo still appears when opening from flows that pass `preselectedRepoId`.
- Verify keyboard navigation (arrow keys, Enter to select, Escape to close popover) works within the combobox.
