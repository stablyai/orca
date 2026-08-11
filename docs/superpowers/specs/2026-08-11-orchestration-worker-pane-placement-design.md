# Orchestration Worker Pane Placement

## Problem

When an agent starts orchestration from a terminal in a secondary split group, a newly created worker session can appear in the first split group. Worker creation carries the workspace but not the coordinator tab that owns the intended group. Background publication and renderer adoption therefore fall back to active-group state, which is not durable evidence of the coordinator's location.

## Goal

An orchestration worker created in an existing workspace must be added to the same outer split group as the coordinator terminal that started it.

The placement must behave consistently for local windows, folder workspaces, SSH/runtime-hosted workspaces, and headless session snapshots. Worker startup must still succeed when placement evidence is unavailable.

## Non-goals

- Moving workers created in a new child or top-level worktree back into the coordinator workspace.
- Changing terminal-internal leaf splits.
- Focusing the worker tab or changing orchestration's background surfacing behavior.
- Reorganizing existing worker tabs.

## Design

### Placement anchor

The worker-start path resolves the coordinator terminal before creating an existing-workspace worker. It passes the coordinator's outer tab ID as an optional placement anchor in terminal creation options.

The anchor identifies intent without exposing renderer-only group IDs to orchestration. Group IDs remain owned by the current session layout, while the stable coordinator tab is already known to local, SSH, and headless runtime paths.

### Runtime publication

Before publishing a new PTY-backed session tab, the runtime looks up the group that owns the anchor tab in the current workspace snapshot. When found, the new worker parent tab is assigned to that group and inserted after the anchor. The active group and active tab are unchanged because orchestration workers remain background sessions.

When no renderer is attached, the same resolved assignment is written into the headless session snapshot. This keeps SSH and folder-workspace behavior aligned with the desktop path.

### Renderer adoption

The terminal reveal request carries the optional placement anchor. The renderer resolves the anchor against unified tabs and uses its group when creating the worker tab. If snapshot publication won the race and the worker tab already exists, adoption verifies its group and moves it to the anchor group without activating it.

The request uses an optional field. Older receivers ignore it, and newer receivers fall back when older senders omit it, so no runtime protocol bump or capability negotiation is required.

### Fallbacks

If the coordinator tab was closed, reminted, belongs to another workspace, or is missing from a partial snapshot, worker creation uses the existing active-group fallback. Placement failure never fails an otherwise valid worker start.

New-worktree workers retain their current behavior because their target workspace has no coordinator tab group to inherit.

## Data flow

1. `orchestration.workerStart` resolves `params.from` to the coordinator terminal.
2. Existing-workspace worker creation passes the coordinator tab ID as the placement anchor.
3. `createTerminal` preserves the optional anchor through agent launch resolution.
4. The runtime assigns the new PTY-backed parent tab to the anchor's snapshot group when available.
5. Terminal reveal forwards the anchor to the renderer.
6. The renderer creates or reconciles the worker tab in the anchor's unified-tab group without changing focus.

## Testing

Focused regression coverage will verify:

- Existing-workspace worker creation forwards the coordinator tab ID.
- A worker started from group B is published into group B while group A remains globally active.
- Renderer creation uses the anchor group for a fresh tab.
- Renderer reconciliation moves an already-published worker tab into the anchor group without activating it.
- A stale or cross-workspace anchor falls back without failing creation.
- Headless and SSH-compatible snapshot placement preserves multi-group layout.
- Folder workspaces use the same existing-workspace path.
- New-worktree workers are unchanged.

## Acceptance criteria

- With two split groups, orchestration started from the second group creates its existing-workspace worker tab in the second group.
- The first group does not receive the worker tab.
- The coordinator remains focused and the worker remains a background session.
- Worker startup succeeds when the placement anchor cannot be resolved.
- Existing mixed-version behavior remains functional when the optional anchor is absent or ignored.
