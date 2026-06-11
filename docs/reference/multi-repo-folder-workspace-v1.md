# Multi-Repo Folder Workspace V1

## Summary

V1 implements real folder workspaces for multi-repo agent work.

When a user imports or selects a parent folder, Orca should persist that folder as a folder-backed
sidebar scope. Users can create normal Orca workspaces under that folder scope. Those folder
workspaces behave like today's worktree workspaces for terminals, agents, tabs, sleep, resume, and
session state, but they are backed by a directory instead of a git worktree.

The folder workspace itself has no direct source control or checks. Source control, checks, commits,
pushes, and reviews remain on child repo worktrees. Agents launched in a folder workspace start with
cwd set to the real folder path and can use the existing Orca CLI repo/worktree commands against
repos contained by that folder.

## User Model

Given:

```text
~/work/platform
  AGENTS.md
  api/                  git repo
  web/                  git repo
  packages/shared/
    repo1/              git repo
    repo2/              git repo
```

Orca should model:

```text
Platform                folder scope: ~/work/platform
  Workspaces
    refund fix          folder workspace cwd: ~/work/platform
  Repos
    api                 repo: ~/work/platform/api
    web                 repo: ~/work/platform/web
  Scopes
    packages/shared     folder scope: ~/work/platform/packages/shared
      Workspaces
        shared cleanup  folder workspace cwd: ~/work/platform/packages/shared
      Repos
        repo1
        repo2
```

The exact visual grouping can follow existing sidebar patterns, but the product contract is:

- Folder scopes are backed by actual directories.
- Folder workspaces are persisted workspaces under folder scopes.
- Agents spawned in folder workspaces launch at the folder path.
- Child repos remain normal Orca repos.
- Child repo worktrees remain normal Orca worktrees.

## V1 Goals

- Keep the selected parent folder as a persisted, launchable folder-backed sidebar scope.
- Create sparse nested folder scopes from selected repo paths.
- Assign repos to the nearest meaningful folder scope.
- Let users create workspaces under each folder-backed scope.
- Make folder workspaces behave like normal workspaces for agents, terminals, tabs, browser state,
  editor state, sleep, resume, and activation.
- Launch folder-workspace agents and terminals with cwd set to the actual folder path.
- Ensure agents in folder workspaces can use existing Orca CLI/runtime repo and worktree commands,
  such as `orca worktree create --repo path:<repo-path> --name <task> --json`.
- Adapt old flat folder-scan groups on load when the persisted data is safe to migrate.
- Preserve separate-import mode, manual groups, and groups that already have child groups.

## Non-Goals

- Multi-repo source-control aggregation.
- Reconnect or move handling for renamed folders.
- Prompt-injected repo graphs or generated agent context.
- Automatically creating worktrees in every child repo when a folder workspace is created.
- Treating initially imported repos as an edit permission boundary.
- Replacing existing repo/worktree CLI commands with a new broad folder CLI.

## Product Contract

A folder workspace should feel like a normal Orca worktree workspace except it is backed by a
directory rather than a git worktree.

Folder workspace behavior:

- Shows in the sidebar under a folder-backed scope.
- Has a user-visible name.
- Can carry normal workspace metadata such as comment, unread, pinned, ordering, and activity time
  where existing UI supports those concepts.
- Owns terminals, agents, browser tabs, editor tabs, split layout, and session restore.
- Launches terminals and agents with cwd equal to the folder scope's real path.
- Can be created from the root imported folder or from a sparse nested folder scope.
- Can be selected as the active workspace.
- Can be slept, resumed, and removed like normal workspaces.

Folder workspace limitations:

- It is not a `Worktree` from git's perspective.
- It is not attached to one repo ID.
- It is not shown in repo source-control regions as a changed checkout.
- It has no direct branch, commit, push, PR/MR, checks, conflicts, publish, or stale-base UI.
- Orca must not run git status against the folder workspace path as if it were one repo.

Source control and checks remain on child repo worktrees. The folder workspace is the task shell:
it gives the agent the right cwd and persistent Orca session state, while repo-scoped work happens
through normal child repo worktrees.

## Relevant Existing Code

- `src/shared/types.ts`
  - `ProjectGroup` already has `parentPath`, `parentGroupId`, and `createdFrom`.
  - `WorkspaceSessionState` is currently keyed by worktree ID and needs a scope-aware path for
    folder workspaces.
- `src/shared/project-groups.ts`
  - Normalizes and creates project groups.
- `src/main/project-groups/nested-repo-import.ts`
  - Resolves nested repo selections and group assignment for imports.
- `src/main/ipc/repos.ts`
  - Local Electron `projectGroups:importNested` handler.
- `src/main/runtime/orca-runtime.ts`
  - Paired/runtime `importNestedRepos` path.
- `src/main/persistence.ts`
  - Load-time normalization, migration, and session persistence.
- `src/renderer/src/components/sidebar/worktree-list-groups.ts`
  - Already renders nested `ProjectGroup.parentGroupId` hierarchies.
- Existing Orca CLI/runtime commands
  - `orca repo list --json`
  - `orca repo add --path <repo-path> --json`
  - `orca repo show --repo path:<repo-path> --json`
  - `orca worktree create --repo path:<repo-path> --name <task> --json`

## Recommended Data Model

Add an explicit workspace scope rather than pretending folders are git worktrees:

```ts
type WorkspaceScope =
  | { type: 'worktree'; worktreeId: string }
  | { type: 'folder'; folderWorkspaceId: string }
```

Persist folder workspaces separately from `Worktree` records:

```ts
type FolderWorkspace = {
  id: string
  projectGroupId: string
  name: string
  folderPath: string
  comment: string
  isArchived: boolean
  isUnread: boolean
  isPinned: boolean
  sortOrder: number
  manualOrder?: number
  lastActivityAt: number
  createdAt: number
  updatedAt: number
}
```

Data model notes:

- `projectGroupId` points at the folder-backed `ProjectGroup` whose `parentPath` is the cwd source.
- `folderPath` is persisted on the workspace too so deleted or rebuilt groups do not orphan
  existing sessions.
- If group and workspace paths diverge, prefer the workspace path when launching that workspace.
  Reconnect/move UX is a later version.
- Reuse existing `WorktreeMeta`-style fields where practical for display, pinning, unread,
  ordering, sleep, and activity.
- Do not add git fields such as `linkedPR`, `pushTarget`, `sparseDirectories`, or `baseRef` to
  folder workspace records unless a UI explicitly needs them.
- Do not encode folder workspaces as fake `repoId::path` worktree IDs. That would leak into source
  control, checks, repo lookup, and git worktree detection paths.

## Workspace Session State

Folder workspaces need the same terminal/browser/editor/tab state as worktree workspaces. Current
session fields are named like `tabsByWorktree`, `browserTabsByWorktree`,
`openFilesByWorktree`, and `activeWorktreeId`.

V1 should make this scope-aware. Acceptable approaches:

- Introduce parallel `*ByWorkspace` maps keyed by canonical workspace keys.
- Or migrate existing maps to canonical keys such as `worktree:<worktreeId>` and
  `folder:<folderWorkspaceId>`.

Prefer canonical workspace keys if the blast radius is manageable:

```ts
type WorkspaceKey = `worktree:${string}` | `folder:${string}`
```

Requirements:

- Existing persisted worktree session state must migrate without losing tabs or layouts.
- Folder workspace tabs, terminals, browsers, and editor state must persist and restore.
- Active workspace state must distinguish worktree scopes from folder scopes.
- Git-only code must resolve worktree scopes explicitly and reject folder scopes.
- If v1 keeps legacy `*ByWorktree` field names for compatibility, add comments explaining that the
  map keys may be workspace keys, not only raw worktree IDs.

## Sparse Folder Scope Import

For grouped nested-repo import, create one root folder-backed Project Group for the selected parent.
Then derive sparse nested folder scopes from selected repo paths.

Create a nested folder scope when:

- A non-root folder has at least two direct repos.
- A non-root folder has direct repos and nested repo descendants.
- A non-root folder has a recognized instruction/config file, if the implementation can detect
  that through the runtime path APIs without local-only filesystem assumptions.

Skip:

- The root relative path, because the root group already represents the selected parent.
- Intermediate folders that only lead to one meaningful child scope.
- Paths outside the selected parent.

Store generated child groups with:

- `createdFrom: 'folder-scan'`
- `parentPath` equal to the actual runtime path for that scope
- `parentGroupId` pointing to the nearest meaningful parent group or root

Name sparse child groups with the relative scope path, such as `packages/shared`, rather than only
the basename. Since sparse derivation skips one-child intermediate folders, the relative path
preserves filesystem context without adding extra hierarchy.

Wire selected repo paths through both:

- `src/main/ipc/repos.ts`
- `src/main/runtime/orca-runtime.ts`

Use shared runtime path helpers such as `relativePathInsideRoot`, `resolveRuntimePath`, and
`isPathInsideOrEqual`. Do not use Node `path.relative` for runtime paths.

## Existing Flat Group Adaptation

On store load, adapt only safe old flat folder-scan cases:

- Root group has `createdFrom === 'folder-scan'`.
- Root group has a non-empty `parentPath`.
- Root group has no `parentGroupId`.
- No group currently has this root as `parentGroupId`.
- Candidate repos are non-folder repos already assigned directly to that root group.
- Candidate repo paths are inside the root `parentPath`.
- At least two candidate repos exist.

Then reuse the same sparse resolver to create child groups and reassign candidate repos. This is a
one-way load migration for older flat state. Do not rebuild groups that already have child
hierarchy. Do not touch manual groups.

Repo ordering during adaptation should be deterministic and bounded to the old flat group. Reassign
only candidate repos and reset `projectGroupOrder` within each newly derived sibling group based on
persisted repo iteration order.

## Workspace Creation Under Folders

The sidebar should expose a create-workspace action for every folder-backed scope with a
`parentPath`.

Creation behavior:

- Creating from the root folder starts from the selected parent folder.
- Creating from a nested folder starts from that nested folder's `parentPath`.
- Creating from a repo keeps using existing repo/worktree behavior.
- Default folder workspace names can follow existing workspace naming conventions but must not
  create a git branch.
- The first terminal starts at the folder path.
- Agent-backed creation launches the chosen agent in that first terminal at the folder path.
- Creating a second folder workspace under the same folder creates a distinct workspace record with
  its own session state.
- Removing a folder workspace removes Orca metadata only. It must not delete the backing folder,
  child repos, or child repo worktrees.

Sidebar behavior:

- Folder-backed Project Groups render folder scopes.
- Folder workspaces render under their owning folder scope, ideally in a "Workspaces" region.
- Repo rows under the same folder remain normal repos and keep existing repo/worktree affordances.
- Folder workspace cards omit direct SCM/checks/PR badges.
- Agent activity, terminal activity, sleep state, unread, pinning, and comments may mirror normal
  workspace cards.
- Actions that require a git worktree must not appear for folder workspaces.

Components may be shared with normal worktree cards, but pass an explicit scope/type prop and gate
git-only controls with `scope.type === 'worktree'`.

## Agent Runtime And Existing Orca CLI

Agents launched from a folder workspace should start with cwd set to the folder path and should get
Orca environment/context values that identify the folder workspace and folder-backed group:

```bash
ORCA_WORKSPACE_ID=...
ORCA_PROJECT_GROUP_ID=...
ORCA_WORKSPACE_ROOT=/path/to/parent-folder
```

The existing Orca CLI/runtime repo and worktree commands should work from that context. Example:

```bash
orca repo show --repo path:/Users/me/work/platform/api --json
orca worktree create --repo path:/Users/me/work/platform/api --name refund-fix --json
orca worktree create --repo path:/Users/me/work/platform/web --name refund-fix --json
```

V1 should not require a new broad folder-workspace CLI command before this workflow is useful.

Runtime requirements:

- Local and SSH/runtime launches must use the runtime path format for the target environment.
- Terminal creation must accept a folder workspace scope and cwd without trying to resolve a repo
  from that cwd.
- Existing repo path selectors should work for child repos.
- `active` or `current` worktree selectors may not resolve from a folder workspace because the
  current workspace is not a git worktree. That is acceptable for v1; agents should use explicit
  repo selectors for child repo worktree creation.
- CLI terminal operations that target the current Orca workspace should resolve a folder workspace
  as a workspace scope even though it cannot resolve as a `Worktree`.
- Agents may still run raw `git worktree add`. Git's worktree registry remains the source of truth
  for discovered child checkouts.

## Source Control And Checks Boundary

V1 deliberately keeps folder workspaces out of repo-specific git features:

- Do not run git status against the folder workspace path.
- Do not show branch, ahead/behind, PR/MR, checks, conflicts, publish, or stale-base controls on
  folder workspace cards.
- Do not include folder workspaces in repo worktree lists.
- Do not include folder workspaces in source-control polling loops.
- Do not implement aggregate source control in v1.
- Child repo worktrees created from a folder workspace behave exactly like normal Orca worktrees for
  source control and checks.

The parent folder may contain multiple repos, non-repo folders, scripts, docs, or generated files.
Treating it like one git checkout would be wrong.

## Implementation Sequence

1. Implement sparse folder scope import.
   - Extend `createNestedProjectGroupResolver` to accept selected repo paths.
   - Create child `ProjectGroup`s only for meaningful sparse scopes.
   - Wire selected paths through local IPC and runtime import paths.
   - Add resolver and import tests first.

2. Add folder workspace records.
   - Add shared types for `FolderWorkspace`, `WorkspaceScope`, and possibly `WorkspaceKey`.
   - Add persistence storage, normalization, create/update/delete methods, and tests.
   - Keep folder workspaces separate from `Worktree` and `WorktreeMeta`.

3. Make session state scope-aware.
   - Choose the canonical workspace key strategy.
   - Update terminal/editor/browser/tab maps so folder workspaces can own the same UI state as
     worktrees.
   - Preserve existing persisted worktree session state during migration.

4. Add sidebar projection and actions.
   - Render folder-backed Project Groups as scopes.
   - Render folder workspaces under their owning folder scope.
   - Add create-workspace action for scopes with `parentPath`.
   - Gate git-only worktree actions and badges away from folder workspaces.

5. Add folder workspace activation and launch.
   - Activating a folder workspace opens/restores its session.
   - Creating terminals/agents uses the folder path as cwd.
   - Environment/context includes workspace ID, project group ID, and workspace root.
   - Local and SSH/runtime paths both flow through runtime path helpers.

6. Verify existing CLI behavior from a folder workspace.
   - From a terminal launched at the parent folder, use explicit child repo selectors with existing
     commands.
   - Confirm repo worktrees created this way appear as normal child repo worktrees.

7. Add old flat group adaptation.
   - Migrate only the safe old `folder-scan` shapes described above.
   - Leave manual and already-nested groups unchanged.

## Validation Plan

Project group/import tests:

- Sparse nested group creation.
- Relative-path child group names for skipped intermediate folders.
- Direct repos plus nested descendants.
- Separate import creates no groups.
- Partial failure cleanup when no repos import or match existing repos.
- Windows path behavior.
- Existing path selection safety tests still pass.

Persistence tests:

- Folder workspace records persist and normalize.
- Folder workspace create/update/delete works.
- Existing worktree session state migrates to scope-aware storage.
- Folder workspace tabs, browsers, editor state, terminal layouts, and active workspace state
  restore after reload.
- Load-time adaptation of old flat folder-scan groups.
- Migration preserves manual and already-nested groups.

Sidebar/UI tests:

- Folder scopes render from `ProjectGroup.parentPath`.
- Folder workspaces render under the correct folder scope.
- Git-only worktree badges/actions are hidden for folder workspaces.
- Normal workspace affordances such as active state, sleep/resume, unread, pinning, and comments
  work for folder workspaces where applicable.

Runtime/CLI tests:

- Creating a folder workspace from a root folder scope launches cwd at the root folder.
- Creating a folder workspace from a nested folder scope launches cwd at the nested folder.
- Agent-backed creation launches the agent at the folder cwd.
- Existing commands work from a folder workspace with explicit child repo selectors:
  - `orca repo show --repo path:<repo-path> --json`
  - `orca worktree create --repo path:<repo-path> --name <task> --json`
- Folder workspace removal does not delete the backing folder or child repos.

Static checks:

- `pnpm run typecheck:node`
- Targeted `oxlint` on touched files.

## Cross-Platform And SSH Requirements

- Do not assume local filesystem access for runtime import grouping, workspace creation, or agent
  launch.
- Do not use OS-specific path separators in persisted logic.
- Use runtime path helpers for local, SSH, and paired clients.
- Keep keyboard shortcuts platform-aware if any UI shortcuts are added.
- Keep review/source-control concepts provider-neutral; this v1 should not add GitHub-only naming.
