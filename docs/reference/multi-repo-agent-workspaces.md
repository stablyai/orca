# Multi-Repo Agent Workspaces

## Problem

Orca supports opening folders and importing multiple repositories from a selected parent folder,
but those paths are currently treated mostly as either folder projects or sidebar organization. That
works for quick access, but it does not give agents a first-class multi-repo folder workspace.

Microservice-style codebases often have a parent folder with several repos and shared agent
instructions at the parent:

```text
~/work/platform
  CLAUDE.md
  api/                repo
  web/                repo
  packages/shared/
    repo1/            repo
    repo2/            repo
```

In that shape, the parent folder is meaningful. It is where a user expects an agent to start when
they say "work across this platform." It may contain instructions, scripts, docs, shared tooling,
or orchestration commands that are not owned by any single child repo.

The current flat import also avoids a real product problem: if the sidebar mirrors the filesystem
too literally, normal sorting gets worse. A hot repo can be hidden under a cold parent folder, and
Recent/Smart ordering becomes harder to scan.

## Goal

Make multi-repo agent work feel first-class by treating a real folder as the workspace. Discovered
git repos inside that folder remain normal Orca projects, while the folder workspace provides the
cwd, parent-level instructions, nested subgroup structure, and task container.

The important product distinction:

- A folder workspace is a durable execution scope with a real folder path.
- Repos inside that folder remain independently addressable Orca projects.
- Nested folders can be launch targets for agents.
- The default sidebar does not have to render the full folder tree.

## Non-Goals

- Do not inject the repo graph into every agent prompt.
- Do not make floating workspace carry the multi-repo product model.
- Do not create a nested group for every filesystem segment.
- Do not collapse multi-repo source control into a fake mono-repo commit.
- Do not assume GitHub-only review concepts; GitLab and other providers must remain supported.
- Do not assume local-only execution. Folder-backed groups must work for SSH/runtime paths.

## Current Shape

`ProjectGroup` already exists in `src/shared/types.ts`, but the repo field comment describes it as
durable sidebar-only organization. It has `parentPath`, `parentGroupId`, and `createdFrom`, which
are close to the data needed for folder-backed execution scopes, but the current meaning is mostly
import provenance and visual grouping.

The nested repo import path already scans a selected parent folder and can create a group from that
selection:

- `src/main/project-groups/nested-repo-discovery.ts`
- `src/main/project-groups/nested-repo-import.ts`
- `src/shared/project-groups.ts`
- `src/renderer/src/store/slices/repos.ts`

`WorkspaceSessionState` is still keyed by worktree ID. That is correct for single-repo workspaces,
but multi-repo folder task workspaces need a higher-level scope that can own several repo/worktree
associations.

## Folder Workspace Framing

The user-facing primitive should be the actual folder, not an abstract Project Group:

```text
Folder Workspace: ~/work/platform
  discovered repos:
    api
    web
    packages/shared/repo1
    packages/shared/repo2
  task workspaces:
    refund fix
    tax export
```

Opening a folder workspace means:

- Orca starts agents at the folder path.
- Orca discovers git repos under that folder and keeps them as normal Orca projects.
- Orca can create multiple task workspaces in the same folder.
- Agents in those task workspaces can use existing Orca CLI/runtime repo and worktree commands to
  create or select repo-scoped workspaces/worktrees for repos contained by that folder.
- Each task workspace can remember same-named child worktrees that Orca created, selected, or
  discovered later inside the discovered repos.
- The folder tree is the agent's natural context; Orca does not need to hide it behind a repo-group
  abstraction.

Project Groups can remain an internal/back-compat substrate for organization, import history, and
sidebar grouping. The product language should be "folder workspace" when the user chose a folder.

## Related Product Request

Issue #1099 asks for workspaces that contain multiple git repositories so users can view diffs
across several repos without switching workspaces. The discussion clarifies a common workflow:
users create same-named worktrees in multiple repos, then manually add the sibling repo directories
to each agent session. The desired behavior is one workspace creation flow that creates or selects
the corresponding checkouts across repos, so new agent sessions implicitly have access to the full
multi-repo working set.

That request is broader than Project Groups as they exist today:

- Source Control needs repo-grouped regions in one workspace.
- Diffs need repo identity so same-named files from different repos do not collide.
- Terminals need an explicit cwd policy.
- Agents need a durable way to discover the folder workspace repos and subfolders without repeating
  manual add-directory commands.
- File tree and search need per-repo labels, fan-out behavior, and per-repo errors.

This document keeps the same broad goal, but narrows the first product step: use the selected
folder as the execution folder for multi-repo agent work, then build persistent task workspaces on
top of that folder. The folder workspace defines membership and folder scope; task workspaces define
runtime/session semantics for a task inside that folder.

## Design Principles

Enable agents first. Orca should make multi-repo context easy to discover, navigate, and act on.
It should not turn the user's initial repo selection into a permission boundary, edit policy, or
hidden constraint on what an agent may decide to change.

1. The chosen parent folder is the workspace folder.
   If the user imports `~/work/platform`, an agent launched from that group should spawn with cwd
   exactly `~/work/platform`. Provider-native instruction discovery can then find parent-level
   files such as `CLAUDE.md` without Orca stuffing that context into the prompt.

2. Metadata should be discoverable, not prompt-polluting.
   In v1, agents should be able to understand the workspace from cwd and the filesystem layout.
   A large generated prompt preamble containing every repo path and status would make user prompts
   noisier and harder to reason about. Structured Orca inspection commands can improve precision in
   v2, but should not be required for the basic agent workflow.

3. The persisted model can be hierarchical while the default display remains sortable.
   Folder scopes should exist for execution and navigation, but Recent/Smart repo sorting should
   still be able to show repos as siblings.

4. Folder scopes should be sparse.
   Create nested folder groups only where they add meaning: multiple repos under the same folder,
   direct repos plus nested repos, or a folder-level instruction/config file.

5. Source control remains per repo, with aggregate presentation.
   A multi-repo workspace can roll up status, diffs, checks, and PRs, but commits and PRs happen
   in each underlying repo.

## Proposed Model

Represent the folder workspace explicitly, backed by existing folder projects and/or Project Group
metadata where useful:

```ts
type FolderWorkspace = {
  id: string
  name: string
  folderPath: string | null
  folderKind: 'folder' | 'manual' | 'reconnected'
  projectGroupId?: string | null
  createdAt: number
  updatedAt: number
}
```

This can be introduced compatibly by treating existing folder projects and folder-scan
`ProjectGroup.parentPath` values as the initial folder paths.

Add a folder task workspace concept for persistent multi-repo tasks:

```ts
type FolderTaskWorkspace = {
  id: string
  folderWorkspaceId: string
  name: string
  cwdPath: string
  worktreeName: string | null
  repoWorktrees: Array<{
    repoId: string
    worktreeId: string
  }>
  createdAt: number
  updatedAt: number
}
```

The folder task workspace is analogous to a normal Orca workspace, but its cwd is the folder
workspace path and it can remember concrete worktree associations for repos in that folder.

`worktreeName` is optional because v1 should support both existing checkouts and coordinated
worktree creation. When present, it records the user's intended task branch/worktree name across
the repo worktrees Orca has created or selected for the task.

`repoWorktrees` is not a permission model and not the complete workspace context. The workspace
context is the folder tree: all repos and subfolders under the folder workspace. `repoWorktrees` only
records concrete checkout choices for repos where Orca has created or selected a task checkout. The
agent and user decide which repos actually need edits during the task.

## Import Behavior

For this folder:

```text
~/work/platform
  api/                repo
  web/                repo
  packages/shared/
    repo1/            repo
    repo2/            repo
```

Import as:

```text
Platform                         folder: ~/work/platform
  api                            repo: ~/work/platform/api
  web                            repo: ~/work/platform/web
  packages/shared                folder: ~/work/platform/packages/shared
    repo1                        repo: ~/work/platform/packages/shared/repo1
    repo2                        repo: ~/work/platform/packages/shared/repo2
```

Do not create an intermediate `packages` group unless it is independently meaningful. In this
example, `packages/shared` is the first useful nested scope because it contains multiple repos.

Suggested nested-group creation rules:

- Always create one folder-backed group for the selected parent folder when importing as a
  group.
- Create a nested folder group when a folder contains multiple imported repos.
- Create a nested folder group when a folder contains direct repo children and nested repo
  descendants.
- Create a nested folder group when a folder has a recognized instruction/config file such as
  `CLAUDE.md` or `AGENTS.md`.
- Skip empty intermediate directories that only lead to one meaningful child.
- Collapse generated child groups by default when there are many.

## Agent Launch Behavior

Launch cwd should depend on the selected scope:

- Launch from `Platform`: cwd is `~/work/platform`.
- Launch from `packages/shared`: cwd is `~/work/platform/packages/shared`.
- Launch from `api`: cwd is `~/work/platform/api`.
- Launch from `repo1`: cwd is `~/work/platform/packages/shared/repo1`.

Orca should not auto-expand all folder repos into the user's prompt. In v1, the cwd and filesystem
layout are the primary agent interface:

```bash
ORCA_WORKSPACE_ID=...
ORCA_PROJECT_GROUP_ID=...
ORCA_WORKSPACE_ROOT=~/work/platform
```

The environment variables are optional hints for Orca-aware scripts. Provider-agnostic agents should
still succeed by starting in the folder workspace and discovering repos normally.

The folder task workspace creation flow should support the workflow from issue #1099:

- Create or select same-named worktrees for repos where Orca can confidently do so.
- Persist those worktree associations so every new agent session in the folder task workspace sees the
  same checkouts.
- Avoid requiring users to re-run provider-specific add-directory commands for each new agent
  session.
- Let agents use existing Orca CLI/runtime repo and worktree commands from the folder workspace to
  create or select workspaces/worktrees in contained repos.
- Provide the full folder workspace tree, including repos and subfolders, so agents can discover other
  repos when the task turns out to span more than the initial checkouts.

The intended v1 workflow is: start the agent at the parent folder, then let Orca create, discover,
or associate child worktrees inside the relevant repos for that folder task workspace. Existing
single-repo child worktree behavior remains the local primitive; the folder task workspace
coordinates those children under one task container.

Agents should be able to use the existing Orca CLI/runtime repo and worktree commands from this
folder context to create or select repo-scoped workspaces/worktrees inside contained repos. This
should not be the only path: agents may still run `git worktree add` directly. Orca should treat
Git's own worktree registry as the source of truth for discovered child checkouts, then let the
folder task workspace remember which discovered worktrees belong together. Using Orca to create a
worktree can add nicer metadata up front, but it should not be required for the worktree to show up
or be linkable after a refresh.

## Sidebar Projection

Separate the stored hierarchy from the default display.

The persisted model can know:

```text
Platform
  api
  web
  packages/shared
    repo1
    repo2
```

The default sortable sidebar can still show:

```text
Platform
  Workspaces
    refund fix
  Repos
    api
    web
    repo1                       packages/shared
    repo2                       packages/shared
  Scopes
    packages/shared
```

This keeps Recent/Smart sorting useful: repos and workspaces can be ordered by activity as siblings,
while folder scopes remain available as launch targets.

Ordering is per folder layer. Each folder sorts its immediate child repos and child folder scopes;
sorting should not pull a repo out of its parent folder or merge unrelated folder layers. In the
default projection, Orca may show repos mostly flat under the selected folder, but path labels should
preserve where nested repos live.

Add an optional "Folder Tree" projection for users who want to browse the hierarchy literally:

```text
Platform
  api
  web
  packages/shared
    repo1
    repo2
```

In folder-tree mode, activity should bubble upward so parent groups reflect their hottest child.
That helps, but it should not be the default for large microservice collections because nested
trees are slower to scan.

## Folder Sync And Reconnect

Folder workspaces are path-backed. If the user renames or moves the parent folder outside Orca, Orca
should not guess destructively or delete anything.

Recommended behavior:

- If the folder path still exists, keep using it.
- If the folder path is missing, mark the folder workspace as disconnected and keep all workspace,
  repo, and task metadata.
- Offer "Locate Folder..." to reconnect the folder workspace to a new path.
- On reconnect, preserve stable Orca IDs where possible and update paths by relative mapping. For
  example, if `~/work/platform` moved to `~/src/platform`, then `api` maps from
  `~/work/platform/api` to `~/src/platform/api`.
- Verify each discovered repo by checking that the expected relative path is still a git repo. If a
  repo is missing, mark that repo association stale rather than removing it.
- If the folder was renamed inside Orca, perform the same path update immediately after the rename
  succeeds.
- For SSH/runtime folders, reconnect should happen through the target's runtime path APIs rather
  than local filesystem assumptions.

This keeps discovered git repos maintained as Orca projects while allowing the containing folder to
move as one unit.

## Source Control

A folder task workspace should show aggregate source-control state, but mutate repos independently:

```text
refund fix

api
  8 files changed
  branch refund-fix
  merge request ready

repo1
  2 files changed
  branch refund-fix
  no review open

web
  no changes
```

Actions should be repo-aware:

- Commit in one repo.
- Commit all changed repos as separate commits.
- Create reviews for changed repos.
- Push changed repos.
- Show which folder workspace repos changed, without treating the initial worktree associations as an edit
  allowlist.

Review naming should stay provider-neutral in shared concepts. Provider-specific calls should live
behind explicit provider checks.

## Floating Workspace Relationship

Floating workspace remains a global scratch surface for terminals, notes, browser tabs, and ad hoc
commands. It is intentionally ambient and should not become the canonical multi-repo task model.

Multi-repo workspaces need durable identity, cwd, repo slots, source-control aggregation, and
agent lifecycle. Those belong to folder workspaces and folder task workspaces.

## Persistence And Runtime

Persist folder workspace metadata and multi-repo task state separately from single worktree session
state.

A future generalization could introduce workspace scopes:

```ts
type WorkspaceScope =
  | { type: 'worktree'; worktreeId: string }
  | { type: 'folder-task-workspace'; folderTaskWorkspaceId: string }
  | { type: 'floating' }
```

This would let tabs, layouts, browser state, and editor state key off a workspace scope instead of
only `worktreeId`, while preserving single-repo compatibility.

For SSH/runtime support, do not store local-only assumptions in the core model. Store folder workspace
paths and repo paths in the runtime path format already used by the target environment, and resolve them
through runtime APIs when launching agents or running CLI commands.

## V2 CLI And Runtime Inspection

The v1 workflow should support the existing Orca CLI/runtime repo and worktree commands for
creating or selecting child repo workspaces from a folder workspace, but it should not require
generated inspection payloads before an agent can get started. The folder workspace,
subdirectories, and parent instruction files should be enough for basic discovery.

In v2, add richer folder workspace inspection APIs before expanding mutating multi-repo actions:

```bash
orca workspace folder --json
orca workspace repos --all --json
orca workspace status --json
```

These should return the current folder workspace, its folder path, subgroups, repos, known task
worktree associations, git status or errors, and provider/connection metadata. `workspace repos
--all` returns every known repo in the folder workspace so agents can broaden their work when
needed. Existing single-worktree git/file/terminal APIs should remain single-repo; do not overload
one worktree selector to sometimes mean many repos.

## P2 Linked Worktree Visibility

Orca should eventually make the coordinated worktree associations visible in the UI and/or CLI.
This is not required for agents to start from the parent folder, but it would help users understand
which per-repo worktrees belong to the same folder task workspace.

Useful surfaces:

- Sidebar or folder task workspace header: show a compact linked-worktree count.
- Source Control: group changes by linked repo worktree and show missing/stale associations.
- Worktree context: show "linked to folder workspace" when a child worktree belongs to one.
- V2 CLI: expose linked worktrees through `orca workspace folder --json`.

This should build on Orca's existing child worktree model rather than introducing a second kind of
worktree. The folder task workspace owns the association; each repo still owns its normal worktree.

## Open Questions

- Should every folder-backed Project Group become a folder workspace immediately, or should manual groups require
  an explicit folder path before agent launch?
- Should `ProjectGroup.parentPath` be migrated to `folderPath`, kept as an alias, or replaced by a
  new `FolderWorkspace` record?
- Should `FolderTaskWorkspace` be a new persisted collection, or should existing workspace/session
  persistence grow a scope discriminator first?
- Which instruction files should make an otherwise sparse folder become a scope?
- Should the initial import default to the flat sortable projection with a visible "Folder Tree"
  toggle, or should users choose during import?

## Rollout

1. Clarify folder workspace semantics.
   - Treat selected folders as folder-backed execution scopes.
   - Reuse existing folder projects and/or add `FolderWorkspace` metadata.
   - Preserve existing flat import behavior until the display projection is ready.

2. Add sparse nested scope import.
   - Create a folder workspace for the selected parent.
   - Create only meaningful child folder scopes.
   - Keep repos sortable per folder layer in the default projection.

3. Add multi-repo agent launch.
   - Launch from folder scopes with cwd at the folder workspace.
   - Set Orca environment variables.
   - Avoid prompt metadata injection.
   - Persist task worktree metadata so new agent sessions do not need manual add-directory setup.

4. Add persistent folder task workspaces.
   - Save named multi-repo task containers under folder workspaces.
   - Track repo/worktree associations without treating them as an edit boundary.
   - Restore tabs, agents, browser, and source-control panels by folder task workspace.

5. Add folder reconnect handling.
   - Mark missing folder workspaces disconnected.
   - Let users locate the moved/renamed folder.
   - Re-map child repo paths by relative path and mark missing repos stale.

6. Add aggregate source-control UI.
   - Roll up changed repos.
   - Keep commit/review actions per repo.
   - Support provider-neutral review flows.

7. Add v2 CLI/runtime inspection.
   - `orca workspace folder --json`
   - `orca workspace repos --all --json`
   - `orca workspace status --json`
   - Runtime equivalents for SSH/web clients.

P2 follow-up:

- Show linked child worktrees for folder task workspaces in the UI and/or CLI.
