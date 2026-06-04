# Worktree Runtime Terminal Activity

## Problem

The sidebar status dot currently decides whether a worktree is active from renderer-owned tab state:

- `tabsByWorktree`
- `browserTabsByWorktree`
- `ptyIdsByTabId`
- explicit agent status rows

That misses a valid runtime state: the runtime can still own a connected PTY after the renderer graph has lost the terminal leaf or after the inline agent row is dismissed. `terminal.list` already has a main-side fallback for those PTY records, so runtime and mobile clients know a terminal exists while the sidebar can still fall back to `Inactive`.

## Approach

Add a small renderer store index:

```ts
runtimeTerminalActivityByWorktreeId: Record<string, true>
```

The index is refreshed from `terminal.list` through `callRuntimeRpc(getActiveRuntimeTarget(...))`, so local runtime, SSH-backed repos, and paired runtime environments use the same abstraction. A worktree is marked active when `terminal.list` reports at least one connected terminal for that worktree.

The index is intentionally worktree-scoped, not tab-scoped. The whole bug is that a connected runtime terminal can be missing from renderer tab bindings, so trying to map it back through a tab would recreate the blind spot.

## Consumers

The runtime activity signal is passed into the existing pure helpers instead of adding card-specific logic:

- `resolveWorktreeStatus` and `getWorktreeStatus`
- `hasActiveWorkspaceActivity`
- Hidden-sleeping workspace filtering
- Smart-sort cold/warm gating
- Cmd+J status dots and sorting
- Collapsed section activity status resolution

Sleep and remove flows clear the worktree's runtime activity entry in the same update that clears live renderer PTYs. Runtime polling also fences in-flight responses by target and reset generation so stale `terminal.list` results cannot revive a worktree after server switches, workspace-session clears, or intentional terminal shutdown.

## Validation

Focused tests should cover:

- Runtime-connected terminal marks a renderer-tabless worktree active.
- A dismissed done row falls back to active, not inactive, when runtime activity remains.
- Sleep/remove clears the runtime activity cache entry for that worktree immediately.
- Smart sort exits cold-start mode when only the runtime activity index has live terminals.
