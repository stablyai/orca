# Proposal

## Why

Existing worktrees can be attached to folder workspaces through Orca CLI, but the left-sidebar parent picker lists Git worktrees only. Users need a discoverable UI action that applies the same folder-parent relationship and updates the sidebar and Workspace Board without creating another checkout.

## What Changes

- Add a separate `Attach to folder workspace…` action to a single Git worktree's left-sidebar context menu, as selected by the user. Keep the existing Git-parent action unchanged.
- Reuse the current searchable parent-picker surface in a folder-only mode. Show existing, non-archived destinations on the child's execution host and owning runtime; distinguish folders by name, group, and path.
- Apply the existing host-validated parent mutation to the captured worktree identity. A new folder parent replaces a previous Git or folder parent without changing Git files, branches, repository registration, or project-group membership.
- Refresh and merge authoritative workspace lineage after attachment. Do not interpret a null Git-lineage reply as proof that the folder link is absent; remove obsolete inline Git-parent presentation only for the affected identity.
- Preserve `Remove from Parent` for detachment and existing sidebar/board rendering. Add keyboard, failure, host-isolation, persistence, and hidden Electron regression coverage.

## Capabilities

### New Capabilities

- `folder-workspace-attachment-ui`: Selecting and applying an existing folder-workspace parent from the sidebar, with owner-safe routing and confirmed lineage presentation.

### Modified Capabilities

None. `orca-cli-workspace-scope` governs implicit agent discovery, not an explicit user's folder selection; folder-import discovery remains unchanged.

## Impact

- Sidebar menu/model and picker: `WorktreeContextMenuView.tsx`, `use-worktree-context-menu-model.tsx`, `use-worktree-parent-picker-transition.ts`, `WorktreeParentPickerPopover.tsx`, and nearby candidate/row/filtering tests.
- Renderer mutation and lineage projection: `store/slices/worktrees/metadata/`, existing operation-owner routing, and the worktree slice's action contract.
- Existing `worktree.set` and `worktree.lineageList` RPCs, including the local runtime gateway. No new public RPC, stream opcode, storage schema, dependency, or agent-status producer.
- Localized menu, picker, empty/loading/error copy and relevant English/runtime/translated catalogs.
- Existing hidden Electron folder-nesting regression plus focused menu, candidate, picker, and lineage tests.
- Assumptions: single-worktree attachment only; any eligible same-host/same-runtime folder is selectable, including a different project group, matching current explicit CLI attachment semantics. No implicit membership edits. Batch attachment, drag-to-folder attachment, new-folder creation, and global picker redesign are out of scope.
