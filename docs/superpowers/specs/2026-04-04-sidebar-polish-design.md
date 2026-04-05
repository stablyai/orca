# Sidebar Polish — Design Spec

## Goal

Redesign the left sidebar to feel cleaner and more minimal, inspired by Kodu-style flat list UI. Reduce visual noise while keeping essential metadata (PR info, CI status) accessible.

## Design Decisions

### Row Layout

Each worktree is a **flat row** (no card borders, no card background).

- **Line 1:** Worktree display name — 14px, semibold
- **Line 2 (conditional):** PR info, shown only when a PR exists
  - PR icon (colored by state: green=open, purple=merged, gray=closed/draft)
  - `#number` in semi-bright text
  - PR title, truncated with ellipsis
  - CI status icon on the far right (green checkmark=passing, red X=failing, spinner=pending)
  - Conflict badge if applicable (e.g. "⚠ Rebasing")
- **No PR:** Row is single-line (just the name). No fallback text.
- **No diff stats** — would require new IPC handler in main process (upstream territory).

### Active Item

- Subtle background highlight: `rgba(255,255,255,0.06)` with `border-radius: 8px`
- No border, no accent bar, no shadow

### Header

- Keep current "WORKTREES" label + view options icon + "+" button
- Same style, just the label and two icons

### Search & Group Controls

- **Remove from permanent UI.** The always-visible search bar and All/PR Status/Repo toggle are removed.
- Search and filtering remain accessible through the existing view options dropdown (sliders icon).

### Bottom Toolbar

- Icons only: help (?) and settings (gear)
- Remove the "Add Repo" text button. Adding repos moves to view options or stays accessible via the existing "+" in the header area.

### Typography & Spacing

- Worktree name: 14px semibold (up from 12px)
- PR meta text: 12px (up from 10-11px)
- Row vertical padding: 12px (up from 8px)
- Row horizontal padding: 14px
- Row gap: 4px margin-bottom
- Row horizontal margin: 8px (for the rounded highlight to have visual inset)

### Status Indicator & Unread

- Terminal status dot and unread bell are **removed from the row** to reduce clutter.
- These remain toggleable in view options if the user wants them back.

## What Changes

### Files to Modify

| File                                                     | Change                                                                                         |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `src/renderer/src/components/sidebar/WorktreeCard.tsx`   | Rewrite layout: flat rows, conditional PR line, bigger text, remove status/unread from default |
| `src/renderer/src/components/sidebar/index.tsx`          | Remove `<SearchBar />` and `<GroupControls />` from render                                     |
| `src/renderer/src/components/sidebar/SidebarToolbar.tsx` | Replace with icons-only layout (settings + help)                                               |
| `src/renderer/src/components/sidebar/SidebarHeader.tsx`  | Keep mostly as-is, minor padding adjustments                                                   |

### Files NOT Modified

- `SearchBar.tsx`, `GroupControls.tsx` — kept as files (not deleted), just not rendered by default
- Everything in `src/main/`, `src/shared/`, `src/cli/` — upstream territory
- `StatusIndicator.tsx` — kept as file, just not rendered by default

## What Stays the Same

- Context menu on right-click
- Double-click to edit worktree meta
- HoverCard on PR row for expanded info
- View options dropdown (sort, card properties toggle)
- Virtualized list rendering
- All existing data fetching (PR, issue, CI)
- Sidebar resize handle
- Add worktree dialog (triggered by "+" button)

## Out of Scope

- Diff stats (+/- lines) — requires main process changes
- Keyboard navigation (up/down arrows) — separate feature
- Search-on-demand (⌘K) — separate feature, current search just hidden
