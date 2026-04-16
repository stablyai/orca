# Fix: Split-group container teardown on worktree switch

## The Bug

When the split-group renderer path is enabled (merged in #669), the container
that hosts all split-group worktree surfaces is conditionally rendered based on
`effectiveActiveLayout` — the layout of the **active** worktree.

When you switch to a newly-activated worktree that has no split-group layout
yet, `effectiveActiveLayout` becomes `undefined`, and React unmounts the entire
container. This destroys:

- **PaneManagers** for every previously mounted worktree
- **xterm.js buffers** (losing all scrollback content)
- **PTY connections** (orphaning running shells)

Switching back to the original worktree remounts everything from scratch,
but the terminal content and shell sessions are gone.

## The Fix

Introduce `anyMountedWorktreeHasLayout` — a check that returns `true` if **any**
mounted worktree (not just the active one) has a split-group layout. The
container stays mounted as long as at least one worktree needs it, but is
hidden via CSS (`hidden` class) when the active worktree has no layout.

This preserves the React tree (and all its xterm buffers and PTY bindings)
across worktree switches while the legacy fallback handles rendering for
the newly-activated worktree until its layout is established.

## Reproduction

1. Open Orca with the split-group renderer enabled (default on main)
2. Have two worktrees open
3. Switch from a worktree with terminal content to a freshly-created worktree
4. Switch back
5. **Before fix:** terminal scrollback and shell session are lost
6. **After fix:** terminal content is preserved

## Would E2E tests fail without this?

**Yes** — the Playwright test `terminal pane retains content when switching
worktrees and back` (in `terminal-panes.spec.ts`) does exactly this
reproduction:

1. Writes a unique marker (`echo WT_RETAIN_...`) to the terminal
2. Switches to another worktree via `setActiveWorktree()`
3. Switches back
4. Asserts the marker is still in the terminal buffer

Without this fix, the split-group container unmounts on step 2 (because the
target worktree has no layout), destroying the xterm buffer. Step 4 fails
because the marker is gone.
