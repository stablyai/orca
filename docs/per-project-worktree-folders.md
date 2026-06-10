# Per-Project Worktree Folders

## Problem

Orca has one global workspace directory and nesting mode in `GlobalSettings`
(`src/shared/types.ts:1688`). Local desktop creation uses
`computeWorktreePath(sanitizedName, repo.path, settings)` and then validates
against either the global workspace root or the WSL-mapped root
(`src/main/ipc/worktree-remote.ts:1116`). Runtime/CLI creation repeats the same
calculation (`src/main/runtime/orca-runtime.ts:7605`).

WSL is not a simple global-root case. `computeWorktreePath` currently ignores
`settings.workspaceDir` for WSL repos when `getWslHome()` succeeds and always
maps to `<wsl home>/orca/workspaces` (`src/main/ipc/worktree-logic.ts:105`).
Passing a project override through the current `settings` parameter would still
be ignored for WSL.

Desktop-managed SSH creation has separate behavior: it does not use global
workspace settings and currently creates a sibling of the repo with the literal
string `${repo.path}/../${sanitizedName}` (`src/main/ipc/worktree-remote.ts:738`).
Current relay `session.registerRoot` is an upgrade-compatibility no-op in new
relays, not an authorization mechanism.

Create-path collision behavior is not uniform. Local desktop creation has a
bounded suffix retry loop (`-2`, `-3`, ...). Runtime/CLI local creation and SSH
creation do not; they fail on branch/path conflicts today.

Project settings already persist per-project worktree-affecting fields such as
`worktreeBaseRef` (`src/shared/types.ts:88`), but the repo update types, IPC/RPC
schemas, renderer update type, and persistence update path do not include a
worktree folder field (`src/main/ipc/repos.ts:912`,
`src/main/runtime/rpc/methods/repo.ts:47`,
`src/renderer/src/store/slices/repos.ts:25`,
`src/main/persistence.ts:2258`).

## Goal

Allow each Git project to optionally define a worktree folder path. New
worktrees for that project are created directly under that folder. Projects
without an override keep current behavior:

- local repos use the global workspace layout, including existing WSL mapping;
- desktop-managed SSH repos use the sibling-of-repo layout;
- runtime/CLI calls use the repo metadata stored in that runtime;
- existing repos and existing worktrees are not moved or rewritten.

## Non-goals

- Do not move, rewrite, or re-parent existing worktrees.
- Do not add a per-project nesting toggle in v1. A project folder override is
  already the project-specific container, so new worktrees are direct children.
- Do not make folder-mode projects create Git worktrees.
- Do not change clone destination defaults.
- Do not add GitHub-only behavior.
- Do not add suffix retry behavior to runtime/CLI or SSH create paths as part of
  this feature.
- Do not accept relative paths or `~` expansion in v1. Store absolute
  runtime-native paths only.
- Do not let desktop-local WSL overrides escape to Windows drive paths in v1.
  WSL repos keep worktrees on the WSL filesystem.

## Design

1. Persist an optional repo field.
   - Add `worktreeFolderPath?: string` to `Repo`.
   - Add it to the renderer `RepoUpdate`, preload/web API typing if narrowed,
     local `repos:update`, runtime `repo.update`, `OrcaRuntimeService.updateRepo`,
     and `Store.updateRepo` allow-lists.
   - Persist the field only for Git repos. If a folder-mode repo reaches the
     boundary with this field, or an update changes a repo to `kind: 'folder'`,
     strip or clear it; the create path must not consult it for folder
     workspaces.
   - Normalize at every IPC/RPC/persistence boundary: accept only strings, trim
     whitespace, reject NUL/control characters, require an absolute path for the
     target runtime/path shape, reject filesystem roots (`/`, drive roots, UNC
     share roots), and store `undefined` for an explicit clear. Do not call host
     `resolve`/`realpath` on SSH or remote-runtime path strings while saving;
     preserve runtime-native strings after shape validation.
   - Runtime RPC cannot rely on `OptionalString -> undefined` for clearing. The
     current `runtime.updateRepo` calls `omitUndefinedProperties(updates)`, which
     drops clear signals before `Store.updateRepo` can delete the field. Preserve
     an explicit clear for `worktreeFolderPath` before that omit step, or accept a
     `null`/empty-string clear sentinel in the RPC schema and translate it to a
     present `undefined` at the store boundary.
   - For desktop-local WSL repos, persisted paths must be in the same distro and
     in the Windows-facing WSL UNC form that `listWorktrees()` returns. If the UI
     accepts a Linux absolute path such as `/home/me/worktrees`, convert it to
     `\\wsl.localhost\<distro>\home\me\worktrees` before storing it. Reject
     Windows drive paths and Linux `/mnt/<drive>` paths for WSL repos in v1;
     otherwise terminal routing, performance assumptions, post-create path
     matching, and local filesystem authorization diverge.

2. Centralize effective layout resolution.
   - Replace the implicit WSL behavior inside `computeWorktreePath` with a helper
     that resolves the effective layout first:
     - project override present and valid for this repo/runtime:
       `{ path: repo.worktreeFolderPath, nestWorkspaces: false, source: 'project' }`;
     - no override and WSL home available: `{ path: <wslHome>/orca/workspaces, nestWorkspaces: settings.nestWorkspaces, source: 'wsl-default' }`;
     - otherwise: `{ path: settings.workspaceDir, nestWorkspaces: settings.nestWorkspaces, source: 'global' }`.
   - The path builder should only join `{ layout.path, repo basename?, sanitizedName }`.
     It must not call `getWslHome()` or remap WSL again after the resolver has
     selected a project override.
   - Pick path operations from the shape of `repo.path` and `layout.path`
     (`win32` for drive/UNC paths, POSIX otherwise). Keep Windows drive paths and
     UNC paths out of POSIX `join`/`resolve`.
   - Validation must use the same path operations and the effective layout root,
     not `settings.workspaceDir` and not the inherited WSL root when
     `source === 'project'`. Replace `ensurePathWithinWorkspace` or make it
     operation-aware; the current helper uses host `path.resolve/relative`.

3. Apply the resolver to create paths.
   - Local desktop `createLocalWorktree`: resolve the effective layout before the
     suffix loop. On each suffix attempt, compute and validate the candidate path
     against `layout.path`; keep the existing branch/path/PR suffix behavior.
   - Runtime/CLI local `createManagedWorktree`: use the same effective layout and
     validation, but preserve current no-suffix behavior.
   - Desktop SSH `createRemoteWorktree`: keep sibling-of-repo semantics when no
     override is set, but compute it with the same remote path helper instead of
     the current literal `${repo.path}/../${sanitizedName}` interpolation. With
     an override, compute `<worktreeFolderPath>/<sanitizedName>` using that
     helper selected from the repo/folder shape. Preserve current no-suffix
     behavior.
   - For SSH relay compatibility, keep the existing priming pattern around
     `session.registerRoot`, but treat it as upgrade-window compatibility only.
     Register the repo path and the computed target path; do not depend on
     registerRoot for security in new relays.
   - Runtime remote helper `createManagedRemoteWorktree` already delegates to
     `createRemoteWorktree`; do not invent a separate path policy there.
   - Do not implicitly `mkdir -p` the override folder in v1. Local browse chooses
     an existing directory; manual SSH/runtime typos should fail clearly before or
     during `git worktree add`, not create unexpected remote directories.

4. Stamp metadata and keep ownership conservative.
   - For new Git worktrees, stamp `orcaCreationWorkspaceLayout.path` and
     `nestWorkspaces` from the effective layout, not always global settings
     (`src/main/ipc/worktree-remote.ts:972`,
     `src/main/ipc/worktree-remote.ts:1361`,
     `src/main/runtime/orca-runtime.ts:7736`).
   - Folder-mode runtime workspaces stay out of scope; do not apply
     `worktreeFolderPath` to the folder-mode branch at
     `src/main/runtime/orca-runtime.ts:7452`.
   - Extend `buildKnownOrcaWorkspaceLayouts` to accept
     `repo.worktreeFolderPath` for local repos only, including repos owned by a
     remote runtime but excluding desktop-managed SSH repos (`connectionId`).
     Add the override as a flat known root (`nestWorkspaces: false`) so existing
     arbitrary worktrees under that folder are not upgraded to strongly
     Orca-managed solely because the setting changed. New worktrees rely on
     their metadata for ownership.
   - Keep SSH layouts out of local ownership and local filesystem authorization.
     SSH paths are meaningful only on the remote host.
   - Extend `getAllowedRoots` in the runtime that owns the repo store to include
     valid non-SSH project folder overrides so file APIs can authorize future
     worktrees outside the global workspace root. Filter out desktop-managed SSH
     repo overrides. The desktop client must not resolve environment-runtime
     strings; the environment runtime authorizes its own local paths.
   - Continue invalidating authorized-root caches after successful local/runtime
     creates. If repo-update handling adds any cached canonical project roots,
     invalidate that cache when `worktreeFolderPath` changes.

5. Surface the setting in Project Settings.
   - In `RepositoryPane`, add a Git-project-only setting next to "Default
     Worktree Base" in Identity (`src/renderer/src/components/settings/RepositoryPane.tsx:245`).
   - Add "Worktree Folder" to the Identity search filter and to
     `repository-search.ts`.
   - Use a local draft and commit on blur/Enter/Browse instead of persisting on
     every keystroke. The create path reads the main/runtime store, so the UI
     should wait for the repo update call to settle before treating the setting as
     saved.
   - Use existing `Input`, `Button`, `Label`, `Tooltip`, and token classes.
   - Helper text: blank inherits the global workspace directory for local/runtime
     projects, including existing WSL default mapping, or the repo sibling folder
     for SSH projects.
   - Show a Browse button only when the active runtime target is local and the
     repo is not SSH-backed. For SSH repos and remote runtime projects, use manual
     text entry because a local folder picker returns a client-local path.

6. Tests.
   - Repo update tests for accepting, trimming, clearing, rejecting non-strings,
     rejecting relative paths and filesystem roots, rejecting WSL drive escapes,
     clearing the field when a repo becomes folder-mode, ignoring folder-mode
     repos, and preserving clear signals through runtime RPC.
   - Effective layout/path tests for inherited global layout, WSL inherited
     layout, WSL override not being remapped to `~/orca/workspaces`, WSL Linux
     input converted to UNC, operation-aware validation on Windows drive paths,
     and UNC paths.
   - Local desktop create tests asserting the project folder path is passed to
     `addWorktree`, the suffix loop checks project-folder candidates, metadata
     stamps the effective layout, and authorized roots are invalidated.
   - Runtime local create tests asserting the override path and metadata layout
     are used without adding suffix retry behavior.
   - SSH create tests asserting legacy sibling semantics are unchanged without an
     override, override behavior creates under the project folder, path helpers
     handle POSIX and Windows-shaped remote paths for both default and override
     cases, and relay root priming remains compatibility-only.
   - Ownership/auth tests asserting local overrides are known roots, SSH overrides
     are ignored locally, and existing worktrees with metadata remain stable when
     the override is changed or cleared.
   - RepositoryPane/search tests asserting the setting is visible for Git repos,
     hidden for folder repos, Browse is hidden for SSH/remote runtime projects,
     and clearing the draft sends an explicit clear.

## Edge Cases

- Empty or whitespace-only input clears the override.
- Changing or clearing the override affects only future creates.
- Existing worktrees keep their current paths and metadata.
- Local overrides outside the global workspace directory are valid and must be
  authorized as project workspace roots.
- Desktop SSH overrides are remote paths; never authorize or browse them through
  local filesystem APIs.
- Desktop-local WSL overrides must compare in WSL UNC form unless the whole
  create/list/auth pipeline is taught to compare Linux and UNC forms together.
- Desktop-local WSL overrides must stay in the same distro's WSL filesystem;
  reject Windows drive paths and Linux `/mnt/<drive>` paths in v1.
- Missing override folders fail clearly; v1 does not create them implicitly.
- Filesystem roots are rejected as overrides so filesystem authorization does not
  widen to an entire drive, share, or POSIX root.
- Windows drive and UNC paths must not be joined or validated with POSIX path
  helpers.
- A create in flight uses the layout resolved when the create handler starts;
  later setting changes affect only later creates.
- The local desktop suffix loop remains bounded and checks the project-folder
  candidate path on each attempt.
- Runtime/CLI and SSH create paths keep their current no-suffix conflict
  behavior.
- Runtime/mobile callers that pass no new create argument inherit the repo's
  persisted setting from the runtime store.
- Multi-window updates remain last-writer-wins through the existing repo update
  flow; create uses the main/runtime store value at the time the create handler
  runs.

## Rollout

1. Add the `Repo.worktreeFolderPath` type and repo update sanitization across
   renderer, IPC, RPC, runtime service, and persistence.
2. Add the effective layout/path helper and tests for global, WSL, Windows, UNC,
   and invalid path cases.
3. Wire local desktop and runtime local creation to the helper, including layout
   metadata and filesystem authorization.
4. Wire desktop SSH creation to use the override while preserving sibling
   defaults and no-suffix behavior.
5. Add the Project Settings UI and search coverage.
6. Run focused tests around worktree logic, IPC worktree creation, runtime
   worktree creation, repo update, ownership/auth, and RepositoryPane, then run
   `pnpm typecheck` and `pnpm lint`.
7. The local checkout ignores `docs/**`; force-add this design doc in the PR
   step with `git add -f docs/per-project-worktree-folders.md`.
