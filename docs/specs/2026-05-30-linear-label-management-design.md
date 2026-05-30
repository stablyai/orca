# Linear label management view

## Goal

Plan upstream issue [#3871](https://github.com/stablyai/orca/issues/3871): support a Linear label management view inside Orca.

The intended outcome is a Linear Labels sub-view in Orca where users can browse and manage Linear issue-label definitions without leaving the app. This is label catalog management, not basic issue label assignment.

## Verified current state

- Orca already has Linear integration backed by `@linear/sdk`.
- The Linear Tasks source already lists issues, supports workspace selection, team metadata, issue details, issue comments, and issue metadata edits.
- Existing issue-label assignment is available in Linear issue edit surfaces through `linearUpdateIssue({ labelIds })` and team label reads.
- GitHub issue labels have a reference interaction model in `src/renderer/src/components/GitHubItemDialog.tsx`: checkbox popover, optimistic mutation, cache patch, revert on failure, and error toast.
- Linear SDK v82 exposes label catalog APIs used by this design: `issueLabels`, `createIssueLabel`, `updateIssueLabel`, `issueLabelRetire`, and `issueLabelRestore`. It also exposes `deleteIssueLabel`, but this spec uses retire/restore for v1 unless a maintainer asks for hard delete.

## Product scope

Add a Linear `Issues / Labels` sub-view switch inside the existing Tasks page when Linear is the selected task source.

Labels view supports:

- Listing Linear issue labels for the selected workspace and selected team scope. If Linear is set to `all` workspaces, the Labels view requires a single workspace before mutations.
- Displaying label name, color, description, scope, group/parent state when available, and retired/archived state when shown.
- Creating a label with name, color, optional description, and scope.
- Editing label name, color, description, and parent/group fields where Linear supports them.
- Retiring a label with confirmation.
- Restoring retired labels if the view exposes retired labels.
- Refreshing labels after mutations.

The existing Linear Issues view remains the default.

## Out of scope

- Bulk label migration.
- Label analytics.
- Cross-provider label sync.
- GitHub label management changes.
- Replacing the existing Linear issue-label assignment UI.
- Keyboard shortcut additions.

## Architecture

### Shared types

Add Linear label catalog types to `src/shared/types.ts`, for example:

- `LinearIssueLabel`
- `LinearIssueLabelCreateInput`
- `LinearIssueLabelUpdateInput`
- `LinearIssueLabelMutationResult`

Use `.ts` types only. Do not add project-owned `.d.ts` files.

The label shape should include only fields the UI needs and the API verifies:

- `id`
- `name`
- `color`
- `description`
- `teamId` / `teamName` when scoped to a team
- `parentId` / `parentName` when present
- `isGroup`
- `retiredAt` / archived status when requested
- `workspaceId` / `workspaceName`

### Main Linear API

Add a focused `src/main/linear/labels.ts` module rather than growing `teams.ts`.

Responsibilities:

- `listIssueLabels({ workspaceId, teamId, includeArchived })`
- `createIssueLabel(input, workspaceId)`
- `updateIssueLabel(id, input, workspaceId)`
- `retireIssueLabel(id, workspaceId)`
- `restoreIssueLabel(id, workspaceId)` when supported in the UI

Use the existing Linear client helpers from `src/main/linear/client.ts` for workspace selection, auth errors, acquire/release, and token clearing. Return mutation envelopes with explicit `ok` and `error` fields for UI display.

### IPC and runtime routing

Extend the current Linear IPC and runtime surfaces:

- `src/main/ipc/linear.ts`
- `src/main/runtime/rpc/methods/linear.ts`
- `src/main/runtime/orca-runtime.ts`
- `src/renderer/src/runtime/runtime-linear-client.ts`
- `src/preload/api-types.ts`

The runtime wrappers should mirror existing Linear issue/team/project functions so local and remote runtime routing behave the same. Validate required mutation fields at IPC boundaries before calling the SDK.

### Renderer

Add `src/renderer/src/components/LinearLabelsWorkspace.tsx`.

Responsibilities:

- Render loading, empty, error, and populated states.
- Show workspace/team scope controls using existing Linear workspace and team data.
- Render label rows/cards with name, color dot, description, scope, and retired state.
- Provide create/edit form in a Dialog or Sheet using shadcn primitives.
- Confirm retire actions with existing confirmation patterns.
- Refresh local label data after mutations.

Wire it into `src/renderer/src/components/TaskPage.tsx` under the Linear source:

- Add Linear sub-view state: `issues` or `labels`.
- Keep Issues selected by default.
- Reuse the Linear toolbar chrome and `docs/STYLEGUIDE.md` tokens.
- Keep issue list/board behavior unchanged.

### Cache invalidation

Linear issue assignment reads labels through `useTeamLabels` and the Linear metadata request cache. After create/edit/retire/restore:

- Clear or invalidate the Linear metadata cache.
- Refresh the Labels view.
- Ensure existing issue edit popovers see updated labels the next time they open.

## UX details

- Use existing shadcn primitives from `src/renderer/src/components/ui/`.
- Use Orca tokens from `src/renderer/src/assets/main.css` and the rules in `docs/STYLEGUIDE.md`.
- Use Linear-provided label colors only for the label marker or chip accent. Keep surrounding chrome neutral.
- Disable submit controls immediately during mutations.
- Show spinner or label swap when mutations take long enough to be visible.
- Surface API errors inline or as toasts, matching nearby Linear issue-edit behavior.
- Use a confirmation dialog for retire because the action affects team workflow metadata.

## Implementation phases

1. Main API and types
   - Add shared label types.
   - Add `src/main/linear/labels.ts`.
   - Add unit tests for SDK mapping, workspace selection, auth clearing, and mutation errors.

2. IPC and runtime
   - Add IPC handlers and preload types.
   - Add runtime RPC methods and `orca-runtime` wrappers.
   - Add validation tests for required fields and invalid payloads.

3. Renderer Labels workspace
   - Add `LinearLabelsWorkspace.tsx`.
   - Add the Linear `Issues / Labels` switch in `TaskPage.tsx`.
   - Implement list, refresh, create, edit, retire, and restore if exposed.

4. Cache and polish
   - Invalidate Linear metadata caches after label mutations.
   - Verify existing Linear issue label assignment sees changed labels.
   - Add renderer tests for loading, empty, error, and mutation flows.

## Acceptance criteria

- Tasks → Linear opens the existing Issues view by default.
- Users can switch to Labels from the Linear source toolbar.
- Labels view loads labels for the selected Linear workspace/team.
- Users can create a Linear issue label with name, color, optional description, and scope.
- Users can edit label name, color, and description.
- Users can retire a label with confirmation.
- If retired labels are shown, users can restore a retired label.
- Mutation errors are visible and do not leave the UI in a false-success state.
- Existing Linear issue-label assignment still works and reflects updated label data after cache invalidation.

## Verification plan

Automated:

- Unit tests for `src/main/linear/labels.ts` mapping and mutation results.
- IPC validation tests for label create/update/retire/restore handlers.
- Runtime RPC method tests for Linear label methods.
- Renderer tests for `LinearLabelsWorkspace` loading, empty, error, create/edit, and retire states.
- Regression test that label cache invalidation updates issue-label assignment data.

Manual UAT:

1. Connect a Linear workspace.
2. Open Tasks → Linear.
3. Switch to Labels.
4. Create a test label.
5. Edit its name/color/description.
6. Retire the label.
7. If restore is exposed, restore the label.
8. Open a Linear issue and confirm the issue label assignment UI reflects the updated labels.

Pre-PR checks from `.github/CONTRIBUTING.md`:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

## Risks and mitigations

- Linear label APIs include workspace-level and team-scoped labels. Keep the first UI explicit about the active scope and verify mutation input against the selected scope.
- Label retirement may affect team workflows. Require confirmation and refresh after mutation.
- Issue assignment uses cached team labels. Invalidate the Linear metadata cache after catalog mutations.
- Remote runtime users need the same behavior as local users. Route all methods through runtime RPC and preload wrappers consistently.

## Build handoff

Approved scope: Linear issue-label catalog management in the existing Linear Tasks area.

Non-goals: bulk migration, analytics, provider sync, GitHub label catalog changes, and replacing existing Linear issue-label assignment.

Likely files:

- `src/shared/types.ts`
- `src/main/linear/labels.ts`
- `src/main/ipc/linear.ts`
- `src/main/runtime/rpc/methods/linear.ts`
- `src/main/runtime/orca-runtime.ts`
- `src/preload/api-types.ts`
- `src/renderer/src/runtime/runtime-linear-client.ts`
- `src/renderer/src/components/LinearLabelsWorkspace.tsx`
- `src/renderer/src/components/TaskPage.tsx`
- `src/renderer/src/hooks/useIssueMetadata.ts`

Required verification: automated tests for main API, IPC/runtime validation, renderer states, cache invalidation, selected-workspace mutation gating, and manual UAT against a Linear workspace.
