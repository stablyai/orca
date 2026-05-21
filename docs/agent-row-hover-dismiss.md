# Agent Row Hover Dismiss Scope

## Problem / Goal

Inline agent rows inside a workspace card show a dismiss X by swapping the row timestamp to an X on hover. When a workspace has multiple agent rows, hovering the workspace currently reveals the X for every row. The goal is to reveal the X only for the individual `DashboardAgentRow` under the pointer while preserving keyboard focus access and the existing timestamp layout.

This quick fix is a reusable interaction-ownership boundary, not a one-off sidebar patch: `DashboardAgentRow` must own its hover scope so anonymous ancestor `.group` state cannot leak in from `WorktreeCard` or future embedding surfaces.

## Relevant Code

- `src/renderer/src/components/sidebar/WorktreeCardAgents.tsx` renders multiple `DashboardAgentRow` instances inside a single workspace card.
- `src/renderer/src/components/dashboard/DashboardAgentRow.tsx` owns the hover crossfade between relative time and dismiss X.
- `src/renderer/src/components/sidebar/WorktreeCardAgents.test.tsx` covers the inline agent list wrapper; a focused row-level test should cover the hover class contract.
- `docs/STYLEGUIDE.md` says list rows should use quiet hover treatment and existing tokens/classes rather than new color values.

## Proposed Design

Use a named Tailwind group on the `DashboardAgentRow` root, for example `group/agent-row`, and update the timestamp/X crossfade classes to use `group-hover/agent-row:*`.

This keeps hover state owned by the row itself instead of any anonymous `.group` ancestor in the workspace card. It should not change layout, colors, spacing, icon sizing, dismissal behavior, or keyboard access. `focus-visible:opacity-100` remains on the X so keyboard users can still reach the control when it receives focus.

Treat row-level contract tests as required for this fix. `WorktreeCardAgents.test.tsx` currently mocks `DashboardAgentRow`, so it cannot detect anonymous `group-hover` leakage inside the row implementation.

Add a focused test for `DashboardAgentRow` that renders a row and asserts:

- the row root uses the named row group;
- dismiss controls use `group-hover/agent-row:opacity-100`;
- the timestamp uses `group-hover/agent-row:opacity-0`;
- no anonymous `group-hover:` class remains on the row's dismiss/timestamp controls.

Also include a two-row wrapper case under an anonymous ancestor `group` to prove the row DOM carries its own hover boundary even when embedded in a hoverable workspace card.

## System Context (Hover Ownership)

```text
useWorktreeAgentRows
        |
        v
WorktreeCardAgents (list wrapper)
        |
        v
DashboardAgentRow (interaction owner)
        |
        v
timestamp <-> dismiss X hover scope
```

`WorktreeCardAgents` provides data/list composition, while `DashboardAgentRow` owns the row interaction contract and hover boundary.

## Data-Flow Coverage

- Happy path: upstream row has valid timestamp + dismiss capability; row renders timestamp/X stack and toggles only within `group/agent-row`.
- Nil/missing timestamp path: row renders standalone dismiss control; visibility still scoped to `group/agent-row`.
- Empty list path: `WorktreeCardAgents` renders no rows; no hover/dismiss UI is present.
- Upstream/malformed data path: row falls back to safe rendering (no crash, no cross-row hover leakage); unusual row shapes such as missing timestamps must still keep dismiss visibility scoped to the row-owned group.

## Edge Cases

- Rows without timestamps use the standalone dismiss button; it must also use the named group hover class.
- Rows with timestamps use the stacked timestamp/X grid; both stacked children must switch on the named group.
- Expanded rows and hidden expand chevrons are unrelated and should remain unchanged.
- Keyboard focus should still reveal the dismiss button even when the row is not hovered.
- Dashboard or other non-sidebar callers should keep the same behavior because the row still owns its own hover group.

## Validation Plan

- Run the focused test for `DashboardAgentRow` / inline agent row behavior.
- Run `pnpm run typecheck`, `pnpm run lint`, and `git diff --check`.
- Launch Electron from this worktree, verify the app identity, use `demo-project`, create or seed a workspace state with multiple agent rows, hover one row at a time, and capture a screenshot showing only the hovered row's X.
- Inspect relevant console/app logs for errors.

## SSH / Cross-Platform Considerations

This change is renderer-only CSS class scoping. It does not alter filesystem paths, keyboard shortcut modifiers, runtime RPC, SSH execution, agent hook parsing, provider behavior, or git-provider-specific behavior.

## Rollout

No migration or feature flag is needed. The change is safe to roll out as a direct bug fix because it narrows hover styling scope without changing dismissal state or persisted agent data.
