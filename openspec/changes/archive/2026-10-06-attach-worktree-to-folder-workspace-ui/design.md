# Design

## Context

See `proposal.md` for motivation and the delta spec for the behavior contract. Current code provides the backend attachment and rendering seams, but not a folder selection path in the sidebar:

- `WorktreeContextMenuView.tsx` and `use-worktree-context-menu-model.tsx` offer the Git-parent picker and `Remove from Parent`. Folder links already count as parent links through `workspaceLineageByChildKey`.
- `WorktreeParentPickerPopover.tsx` lists `useAllWorktrees()` and filters through `getEligibleWorktreeParents`, which requires the same repository. It already supplies search, virtualization, IME-safe keyboard navigation, anchoring, dismissal, and focus restoration.
- `use-worktree-parent-picker-transition.ts` captures a child ID and anchor before closing the menu. Folder mode must also retain the invoked row's checkout identity and owner, rather than resolve a later active row by bare ID.
- `runtime-managed-worktree-metadata.ts` resolves folder parents through the selected runtime store and validates canonical host ownership. A folder edge replaces Git lineage and is stored in workspace lineage.
- `setWorktreeLineageForRuntime` currently reads only Git lineage from mutation replies. `applyWorktreeLineageUpdate` interprets null Git lineage as removal of the workspace edge. It cannot be used unchanged to present a successful folder attachment.
- `callRuntimeRpc` already dispatches `worktree.set` through both the local runtime gateway and paired runtimes. The current selector contract supports exact `identity:<key>` selectors; `Worktree.identity.key` is the existing opaque checkout identity. No endpoint needs to be added.
- Existing exact-owner and folder-owner routing lives in `worktree-owner-route.ts`, `worktree-operation-route.ts`, and `folder-workspace-runtime-owner.ts`. Display-oriented folder host helpers can default missing/conflicting evidence to local; they are not sufficient eligibility proof by themselves.

## Goals / Non-Goals

**Goals:**

- Add the separate context-menu action chosen by the user, while sharing picker mechanics and current native lineage storage.
- Keep attachment tied to the captured checkout occupant, execution host, and runtime transport even when selection/focus changes.
- Treat folder lineage as host-authored state, distinct from the absence of a Git parent.

**Non-Goals:**

- Rename or redesign the existing Git-parent action; add mixed Git/folder candidate lists to that action.
- Batch attachment, drag-to-folder attachment, folder creation, repository discovery, group-membership changes, or new checkout/agent/terminal creation.
- New RPCs, stream frames, persistence schemas, general-purpose scheduling frameworks, or repair of legacy cross-host lineage storage.
- Change CLI archival eligibility or folder-import/CLI-scope behavior.

## Decisions

### 1. Reuse the picker in an explicit folder mode

Add `Attach to Folder Workspace…` beside the current parent controls for single Git worktrees. Extend the existing transition/picker with an explicit folder mode; the original mode, copy, and Git-parent filtering remain unchanged. Capture the row identity, owner route, and anchor at invocation. Do not derive the child from a later active selection or a host-blind worktree map when IDs collide.

Folder mode uses a focused candidate function, proposed as `folder-workspace-parent-candidates.ts`, and the existing folder-to-worktree adapter where a picker row needs that shape. Reuse current Command/Popover/virtualizer, navigation, IME, positioning, and focus-restoration logic. Use a folder icon and name with group/path context rather than pretending the folder is a Git branch. If sharing pushes a file over its line budget, extract the existing picker presentation at its current ownership seam rather than copying its interaction code.

The action can open an informative empty/loading/error surface even when there are no Git-parent candidates. It does not create a destination when the folder list is empty. Selecting the already confirmed parent is disabled or a no-op. Multi-selection and non-Git folder cards do not expose the single-worktree operation.

Alternative: rename the existing picker to a generic parent-workspace picker. Rejected by the user's separate-action choice and because it would change existing Git-parent workflows unnecessarily.

### 2. Filter by execution owner, not repository membership or paths

Refresh folder data through the captured child's owning runtime, using existing catalog/routing functions. Candidate identity includes the folder ID and its owner namespace; display names and paths are descriptive, not selectors. Resolve the child's exact owner record and folder owner from native catalogs, compare both execution-host and transport/runtime ownership, and respect runtime-local aliasing only within that owner namespace. Never equate two different runtime environments because both servers call themselves local, or two SSH targets because their labels match.

Exclude archived/deleted destinations and unknown or ambiguous owner evidence. Do not rely solely on convenience helpers that return local on missing metadata. A same-owner folder from another group is allowed because this is an explicit user selection, not the implicit repo-discovery workflow described by `orca-cli-workspace-scope`. Selecting it never moves the source repository into that group.

The backend remains the final existence/host guard. Recheck that the selected candidate and captured child still match current records before sending. The current backend does not reject a folder solely for being archived: this UI filters and rechecks archived destinations but does not add a new CLI restriction. A concurrent archive after acknowledgement follows authoritative visibility policy rather than fabricating a visible parent.

### 3. Use the existing runtime mutation with exact identity

Add one narrow renderer action for folder attachment in the worktree lineage action layer. It accepts the captured child identity/owner and folder destination. Resolve the owner target from the invoked record, not focused global settings. Prefer the existing `identity:<worktree.identity.key>` selector verbatim and send `parentWorktree: folder:<folderId>` to `worktree.set` via `callRuntimeRpc` for both local and paired targets. Do not pass an identity selector through `toRuntimeWorktreeSelector`, which only adds `id:`, or through the local `updateLineage.worktreeId` contract, whose notification path parses a repo/path locator.

When exact identity or owner evidence cannot safely address the same occupant, refresh metadata or refuse; do not manufacture an identity key from renderer-only host stamps or silently downgrade to an ambiguous ID. Use existing environment request-revision/runtime checks so a replaced pairing cannot redirect a captured operation. Reuse backend host checks and existing folder selectors. A folder mutation is one parent replacement, not an additional edge.

Use a minimal per-identity in-flight guard in the lineage action layer, shared with conflicting parent-change/removal actions, so UI cannot overlap writes to the same captured occupant. This is presentation/request coordination only, not another lineage authority or a general task queue. Do not queue automatic retries. If old shared-key lineage cannot safely distinguish a live foreign instance, refuse rather than promise independent colliding parent edges; no storage migration is part of this feature.

Alternative: call `assignWorktreeParent` unchanged with a folder string. Rejected: its reply projection treats null Git lineage as a cleared workspace link, and bare-ID owner lookup loses the invoked row's identity.

### 4. Reconcile authoritative workspace lineage without false success

After acknowledgement, query the existing `worktree.lineageList` on the same captured target. Reuse host-scoped merging and request-start baselines from `worktree-lineage-refresh.ts`; retain availability information so a missing `workspaceLineage` field is not a confirmed empty map for this operation. Do not synthesize a folder edge from the request or a null Git-lineage reply.

Confirm the child-instance/folder edge, then merge the owner snapshot and remove obsolete Git-parent side-map/inline fields only for the captured occupant. Reuse the existing projection code with identity/host scoping where necessary; do not change every same-ID row across hosts. A detached or changed checkout record must not absorb a late result. Existing sidebar row builders and board projection then consume the confirmed folder link without new caches or precedence rules.

Rejected writes leave the previous confirmed parent untouched. On acknowledged write plus failed/unsupported verification, distinguish acknowledgement from refresh uncertainty; do not roll back host state, claim a confirmed new placement, or silently retry. On transport timeout without acknowledgement, report unknown outcome and require owner-scoped reconciliation before an explicit repeat attempt. Refreshing an unchanged snapshot is not proof that a timed-out operation never ran. Existing baseline-aware merging and the per-identity request guard prevent older reads from overwriting a newer parent change.

The detach entry stays, labelled `Remove from Folder Workspace` for a folder parent and `Remove from Parent` for a Git parent. Its healthy clear operation must still remove folder lineage and restore ordinary placement after this new action; the UI does not delete the checkout.

### 5. Validate the real UI path and localize copy

Add focused tests beside the candidate, menu, picker, and lineage action code. Cover no Git-parent candidates, same-owner folders outside the group, archive filtering, duplicate names/IDs, unknown ownership, active-owner switches, changed child instances, null Git replies with folder edges, omitted workspace lineage, rejected/unknown outcomes, and delayed refreshes. Retain existing Git-parent tests unchanged in meaning.

Extend `tests/e2e/folder-workspace-nesting.spec.ts` with existing unattached children in two disposable repositories. Invoke the actual right-click action and folder picker, verify nesting and board folding, move one child between folders, detach through `Remove from Folder Workspace`, and reload/relaunch to verify persisted identity and lineage. Keep source-repo labels and branch hover coverage. Use current isolated fixture/home/SQLite helpers and CDP screenshots; keep `ORCA_BACKGROUND_LAUNCH=1` and never reveal test windows.

Localize the new action, search/empty/loading/unavailable/failure copy using existing i18n catalogs and generation checks. No new design tokens, font tiers, shadow tiers, or keyboard shortcuts are needed.

## Risks / Trade-offs

- [Display host fallback mistaken for authority] → Validate owner records and namespace before offering or writing a destination; backend rejection remains authoritative.
- [Null Git reply erases a real folder edge] → Give folder attachment its own reconciliation path and require available host-produced workspace lineage.
- [Late results or focus changes target the wrong row] → Capture checkout identity and route, guard overlapping parent writes, and merge against request-start baselines.
- [Older host or interrupted transport cannot prove outcome] → Show unsupported/unknown verification explicitly; no local fallback, fabricated edge, rollback, or automatic resend.
- [Destination archives after selection] → Recheck before dispatch and follow authoritative archive visibility after acknowledgement; do not change CLI archive policy in this UI feature.

## Migration Plan

No stored-data migration. Existing links remain valid and detach remains available. Ship localized UI, candidate filtering, and authoritative mutation/refresh handling together; do not release only a folder row added to the old Git-only response projection. Rollback removes the new action and folder picker mode while preserving host-owned parent links, which remain manageable through CLI and existing detachment.
