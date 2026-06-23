# Plan: Open Agent Instead of Terminal on Worktree Click

## Problem

When you click a worktree in the sidebar, `activateWorktreeFromSidebar` → `activateAndRevealWorktree` runs. Step 4 calls `ensureWorktreeHasInitialTerminal`, which creates a **plain terminal tab** (idle shell) when the worktree has no existing tabs. The user then has to manually launch an agent from the tab bar.

There's already a partial solution: `buildCreatedAgentReopenStartup` checks `worktree.createdWithAgent` and relaunches that agent. But this only fires when:
1. The worktree has zero renderable tabs (first open)
2. The worktree was explicitly created with an agent (via the new-workspace composer or direct task launch)

Worktrees created externally (via `git worktree add`) or from older Orca versions don't have `createdWithAgent`, so they always open a plain terminal.

## Current Flow

```
WorktreeCard.handleClick
  → activateWorktreeFromSidebar(worktreeId)
    → activateAndRevealWorktree(worktreeId)
      → Step 1: setActiveRepo (if crossing repos)
      → Step 2: setActiveView('terminal')
      → Step 3: setActiveWorktree(worktreeId)
      → Step 4: ensureWorktreeHasInitialTerminal(
          state, worktreeId,
          opts?.startup ?? buildCreatedAgentReopenStartup(wt),  ← only if createdWithAgent
          ...
        )
        → shouldAutoCreateInitialTerminal(tabCount === 0)?
          → YES → createTab(worktreeId)  ← plain terminal, no agent
          → NO → skip (existing tabs restored)
```

## Proposed Solution

Add a global setting `openWorktreeWithAgent` (boolean, default `false`) that, when enabled, makes `activateAndRevealWorktree` use the user's `defaultTuiAgent` as the startup command for new terminal tabs — not just `createdWithAgent`.

### Key files to modify

1. **`src/shared/types.ts`** — Add `openWorktreeWithAgent: boolean` to `GlobalSettings`
2. **`src/shared/constants.ts`** — Add default `openWorktreeWithAgent: false` to `DEFAULT_SETTINGS`
3. **`src/renderer/src/lib/worktree-activation.ts`** — Modify `activateAndRevealWorktree`:
   - Add a new `buildDefaultAgentReopenStartup` function that uses `settings.defaultTuiAgent` (similar to `buildCreatedAgentReopenStartup` but reads from global settings instead of worktree meta)
   - Change the startup resolution order at line 337 from:
     ```ts
     opts?.startup ?? buildCreatedAgentReopenStartup(wt)
     ```
     to:
     ```ts
     opts?.startup ?? buildCreatedAgentReopenStartup(wt) ?? buildDefaultAgentReopenStartup(state, wt)
     ```
   - `buildDefaultAgentReopenStartup` checks `settings.openWorktreeWithAgent === true` and `settings.defaultTuiAgent` is set/enabled, then builds the same `WorktreeStartupPayload` as `buildCreatedAgentReopenStartup`
4. **`src/renderer/src/components/settings/AgentsPane.tsx`** — Add a toggle: "Open worktrees with default agent" (only visible when `defaultTuiAgent` is set and not 'blank')
5. **`src/renderer/src/lib/worktree-activation.test.ts`** — Add tests for the new startup resolution

### Startup resolution order (after change)

1. **Explicit `opts.startup`** — caller-provided (e.g. direct task launch, palette with prompt)
2. **`buildCreatedAgentReopenStartup(wt)`** — worktree was created with a specific agent (`createdWithAgent`)
3. **`buildDefaultAgentReopenStartup(state, wt)`** — user enabled "open with default agent" and has a `defaultTuiAgent` set
4. **None** — plain terminal (current behavior, unchanged)

### What does NOT change

- Worktrees with existing tabs are unaffected (no new terminal created)
- Worktrees created with a specific agent still reopen that agent (not the default)
- The setting is opt-in (default `false`) — no behavior change for existing users
- SSH/remote worktrees work the same (launch platform is derived per-repo)
- The `defaultTuiAgent` setting already exists; this just adds a toggle to apply it on worktree activation

### Alternative considered: per-repo setting

A per-repo `openWorktreeWithAgent` could be added to `Repo` instead of `GlobalSettings`. This would let users have different behavior per repo. However:
- The `defaultTuiAgent` is already a global setting
- Adding a per-repo toggle adds UI complexity for marginal benefit
- Can be added later if needed

### Alternative considered: modify `WorktreeCard.handleClick` directly

Could check the setting in the click handler and call `launchAgentInNewTab` instead of `activateWorktreeFromSidebar`. But this would:
- Bypass the activation flow (nav history, sidebar reveal, sleeping agent resume)
- Create a new tab instead of using the initial terminal slot
- Diverge from the existing `createdWithAgent` pattern

The activation flow is the right place — it already has the `buildCreatedAgentReopenStartup` pattern to follow.
