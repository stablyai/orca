# Sidebar Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign the sidebar from dense card-based layout to clean flat rows with minimal metadata, inspired by Kodu-style UI.

**Architecture:** Pure UX-surface changes to 4 sidebar components. No main process, IPC, or store changes. Search/GroupControls components are preserved as files but removed from the default render tree.

**Tech Stack:** React, Tailwind CSS, lucide-react icons

**Spec:** `docs/superpowers/specs/2026-04-04-sidebar-polish-design.md`

---

### Task 1: Remove SearchBar and GroupControls from sidebar

**Files:**

- Modify: `src/renderer/src/components/sidebar/index.tsx`

This is the simplest change — just remove two component renders. SearchBar.tsx and GroupControls.tsx files stay intact for potential future use.

- [ ] **Step 1: Remove imports and component renders**

In `src/renderer/src/components/sidebar/index.tsx`, remove the SearchBar and GroupControls imports and their JSX:

```tsx
// Remove these two imports:
// import SearchBar from './SearchBar'
// import GroupControls from './GroupControls'

// In the return JSX, remove these two lines:
// <SearchBar />
// <GroupControls />
```

The resulting fixed controls section should only contain:

```tsx
{
  /* Fixed controls */
}
;<SidebarHeader />
```

- [ ] **Step 2: Verify in dev**

Run `pnpm dev` (if not already running). Confirm:

- Sidebar renders without search bar and group toggle
- Worktree list still shows all items
- No console errors

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/components/sidebar/index.tsx
git commit -m "feat(sidebar): remove search bar and group controls from default view"
```

---

### Task 2: Simplify SidebarToolbar to icons only

**Files:**

- Modify: `src/renderer/src/components/sidebar/SidebarToolbar.tsx`

Replace the "Add Repo" text button + settings icon with just a settings icon (right-aligned). The "Add Repo" functionality remains accessible through SidebarHeader's "+" button and context menus.

- [ ] **Step 1: Rewrite SidebarToolbar**

Replace the full content of `SidebarToolbar.tsx` with:

```tsx
import React from 'react'
import { Settings } from 'lucide-react'
import { useAppStore } from '@/store'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'

const SidebarToolbar = React.memo(function SidebarToolbar() {
  const setActiveView = useAppStore((s) => s.setActiveView)

  return (
    <div className="mt-auto shrink-0">
      {/* FORK: minimal toolbar — icons only, matching Kodu-style reference */}
      <div className="flex items-center justify-end px-3 py-2 border-t border-sidebar-border">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={() => setActiveView('settings')}
              className="text-muted-foreground"
            >
              <Settings className="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top" sideOffset={4}>
            Settings
          </TooltipContent>
        </Tooltip>
      </div>
    </div>
  )
})

export default SidebarToolbar
```

- [ ] **Step 2: Verify in dev**

Confirm:

- Bottom toolbar shows only the gear icon, right-aligned
- Clicking gear still opens settings
- No console errors

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/components/sidebar/SidebarToolbar.tsx
git commit -m "feat(sidebar): simplify toolbar to settings icon only"
```

---

### Task 3: Adjust SidebarHeader padding

**Files:**

- Modify: `src/renderer/src/components/sidebar/SidebarHeader.tsx`

Increase top padding to give the header more breathing room, matching the reference's more spacious feel.

- [ ] **Step 1: Update padding**

In `SidebarHeader.tsx`, change the outer div's padding class from `px-4 pt-3 pb-1` to `px-4 pt-4 pb-2`:

```tsx
// Old:
<div className="flex items-center justify-between px-4 pt-3 pb-1">

// New:
<div className="flex items-center justify-between px-4 pt-4 pb-2">
```

- [ ] **Step 2: Verify in dev**

Confirm:

- Header has slightly more vertical space
- "WORKTREES" label, sliders icon, and "+" button still visible and functional

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/components/sidebar/SidebarHeader.tsx
git commit -m "feat(sidebar): increase header padding for cleaner spacing"
```

---

### Task 4: Rewrite WorktreeCard to flat row layout

**Files:**

- Modify: `src/renderer/src/components/sidebar/WorktreeCard.tsx`

This is the main change. The card becomes a flat row with:

- Line 1: worktree display name (14px semibold)
- Line 2 (only if PR exists): PR icon (colored by state) + `#number` + PR title + CI icon on far right + conflict badge if applicable
- No line 2 if no PR
- Active state: subtle background, rounded corners
- No status indicator, no unread bell, no repo badge, no branch name, no issue, no comment visible by default

All the existing hooks, data fetching, context menu, double-click, and HoverCard behavior remain — only the visual render changes.

- [ ] **Step 1: Rewrite the JSX return of WorktreeCard**

Replace the JSX inside the `<WorktreeContextMenu>` wrapper (lines 231-496) with the new flat row layout. Keep all hooks, callbacks, and logic above the return unchanged.

```tsx
return (
  <WorktreeContextMenu worktree={worktree}>
    <div
      className={cn(
        // FORK: flat row layout — no card borders, generous padding, subtle active highlight
        'group relative flex flex-col px-3.5 py-3 rounded-lg cursor-pointer transition-all duration-200 outline-none select-none mx-2',
        isActive ? 'bg-white/[0.06] dark:bg-white/[0.06]' : 'hover:bg-accent/30',
        isDeleting && 'opacity-50 grayscale cursor-not-allowed'
      )}
      onClick={handleClick}
      onDoubleClick={handleDoubleClick}
      aria-busy={isDeleting}
    >
      {isDeleting && (
        <div className="absolute inset-0 z-10 flex items-center justify-center rounded-lg bg-background/50 backdrop-blur-[1px]">
          <div className="inline-flex items-center gap-1.5 rounded-full bg-background px-3 py-1 text-[11px] font-medium text-foreground shadow-sm border border-border/50">
            <LoaderCircle className="size-3.5 animate-spin text-muted-foreground" />
            Deleting…
          </div>
        </div>
      )}

      {/* Line 1: Worktree name */}
      <div className="text-[14px] font-semibold text-foreground truncate leading-tight">
        {worktree.displayName}
      </div>

      {/* Line 2: PR info (only if PR exists) */}
      {showPR && pr && (
        <div className="flex items-center gap-1.5 mt-1.5 min-w-0">
          <PullRequestIcon
            className={cn(
              'size-3.5 shrink-0',
              pr.state === 'merged' && 'text-purple-500/80',
              pr.state === 'open' && 'text-emerald-500/80',
              pr.state === 'closed' && 'text-muted-foreground/60',
              pr.state === 'draft' && 'text-muted-foreground/50',
              (!pr.state || !['merged', 'open', 'closed', 'draft'].includes(pr.state)) &&
                'text-muted-foreground opacity-60'
            )}
          />
          <a
            href={pr.url}
            target="_blank"
            rel="noreferrer"
            className="text-[12px] text-foreground/80 font-medium shrink-0 hover:underline"
            onClick={(e) => e.stopPropagation()}
          >
            #{pr.number}
          </a>
          <span className="text-[12px] text-muted-foreground truncate">{pr.title}</span>

          {/* Right side: CI check + conflict badge */}
          <div className="flex items-center gap-1.5 ml-auto shrink-0">
            {conflictOperation && conflictOperation !== 'unknown' && (
              <span className="text-[11px] text-amber-500 dark:text-amber-400 whitespace-nowrap">
                ⚠ {CONFLICT_OPERATION_LABELS[conflictOperation]}
              </span>
            )}
            {showCI && pr.checksStatus !== 'neutral' && (
              <>
                {pr.checksStatus === 'success' && (
                  <CircleCheck className="size-3.5 text-emerald-500" />
                )}
                {pr.checksStatus === 'failure' && <CircleX className="size-3.5 text-rose-500" />}
                {pr.checksStatus === 'pending' && (
                  <LoaderCircle className="size-3.5 text-amber-500 animate-spin" />
                )}
              </>
            )}
          </div>
        </div>
      )}

      {/* Conflict badge shown even without PR */}
      {!(showPR && pr) && conflictOperation && conflictOperation !== 'unknown' && (
        <div className="flex items-center gap-1 mt-1.5">
          <span className="text-[11px] text-amber-500 dark:text-amber-400">
            ⚠ {CONFLICT_OPERATION_LABELS[conflictOperation]}
          </span>
        </div>
      )}
    </div>
  </WorktreeContextMenu>
)
```

- [ ] **Step 2: Clean up unused imports**

After rewriting the JSX, these imports are no longer used in the render and can be removed:

```tsx
// Remove these imports:
import { Badge } from '@/components/ui/badge'
import { HoverCard, HoverCardTrigger, HoverCardContent } from '@/components/ui/hover-card'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'
import { Bell, GitMerge } from 'lucide-react'
import StatusIndicator from './StatusIndicator'
import type { Status } from './StatusIndicator'
```

Also remove the `FilledBellIcon` component (lines 67-78), the `isPrimaryBranch` function (lines 28-31), and the `PRIMARY_BRANCHES` constant (line 28).

Keep: `PullRequestIcon`, `branchDisplayName`, `prStateLabel`, `checksLabel`, `CONFLICT_OPERATION_LABELS`, and all the hooks/callbacks inside the component.

- [ ] **Step 3: Verify in dev**

Confirm:

- Each worktree shows as a flat row with just the name
- Worktrees with PRs show a second line: PR icon + number + title
- Active worktree has subtle highlight
- CI icons appear on the far right of the PR line
- Rows without PR are single-line
- Right-click context menu still works
- Double-click to edit still works
- No console errors

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/components/sidebar/WorktreeCard.tsx
git commit -m "feat(sidebar): rewrite card as flat row with conditional PR line"
```

---

### Task 5: Update virtualizer row height estimate

**Files:**

- Modify: `src/renderer/src/components/sidebar/WorktreeList.tsx`

The row height changed: old cards were ~56px, new flat rows are different:

- Single-line row (no PR): ~14px font + 24px padding = ~38px
- Two-line row (with PR): ~14px + 6px gap + 14px + 24px padding = ~58px

Use ~46px as average estimate (virtualizer adjusts via `measureElement`).

- [ ] **Step 1: Update estimateSize**

In `WorktreeList.tsx`, line 229, change the item estimate:

```tsx
// Old:
estimateSize: (index) => (rows[index].type === 'header' ? 42 : 56 + 4),

// New:
// FORK: flat row height — shorter rows without card borders/padding
estimateSize: (index) => (rows[index].type === 'header' ? 42 : 46),
```

- [ ] **Step 2: Verify in dev**

Confirm:

- Scrolling through the worktree list is smooth
- No gaps or overlapping rows
- Virtualizer correctly measures actual row heights

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/components/sidebar/WorktreeList.tsx
git commit -m "feat(sidebar): adjust virtualizer row height for flat layout"
```

---

### Task 6: Visual QA and final adjustments

No specific file changes — this is a manual review step.

- [ ] **Step 1: Full visual check**

With `pnpm dev` running, verify all states:

- Active worktree: subtle highlight, correct
- Worktree with open PR: green PR icon + number + title
- Worktree with merged PR: purple PR icon
- Worktree with closed PR: gray PR icon
- Worktree with no PR: single-line, just name
- Worktree with CI passing: green checkmark on PR line
- Worktree with CI failing: red X on PR line
- Worktree with CI pending: spinning amber icon
- Worktree with conflict operation: "⚠ Rebasing" badge
- Worktree being deleted: overlay with spinner
- Empty state (no worktrees): "No worktrees found" message
- Header: "WORKTREES" + view options + "+" button
- Bottom: settings gear icon only
- Sidebar resize handle still works
- Light mode (toggle theme in settings): verify colors look correct in both themes

- [ ] **Step 2: Fix any issues found**

If any visual issues are spotted, fix them in the relevant component file.

- [ ] **Step 3: Final commit (if fixes were needed)**

```bash
git add -A
git commit -m "fix(sidebar): visual QA adjustments"
```
