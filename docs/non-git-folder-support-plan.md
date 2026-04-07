# Non-Git Folder Support Plan

## Summary

Orca should support opening non-git folders in a limited "folder mode" so users can still use:

- terminal
- file explorer
- editor
- search
- quick open

Git-dependent features should remain unavailable in this mode:

- creating worktrees
- removing git worktrees
- source control
- branch/base-ref workflows
- pull request and checks integrations

The recommended implementation is to model a non-git folder as a repo with exactly one synthetic worktree representing the folder itself.

## Product Model

### Repo Types

Introduce two repo modes:

- `git`
- `folder`

This can be stored directly on `Repo`, for example as `kind: 'git' | 'folder'`.

Why: Orca currently assumes every connected repo can enumerate git worktrees and branch metadata. Making repo type explicit lets the UI and IPC handlers suppress git-only functionality without scattered heuristics.

### Synthetic Worktree for Folder Mode

For a non-git folder, Orca should synthesize exactly one worktree-like entry:

- `path = repo.path`
- `displayName = repo.displayName`
- `isMainWorktree = true`
- `branch = ''`
- `head = ''`
- `isBare = false`

The worktree ID can remain `${repo.id}::${repo.path}` to preserve the existing store shape.

This ID contract should be treated as stable for folder mode.

Why: much of the app is worktree-centric. Reusing the existing worktree abstraction is less invasive than teaching the editor, terminal, explorer, quick-open, and selection state to operate without any worktree at all.

## User Experience

### On Add / Load Attempt

When a selected folder is not a git repo, Orca should show a confirmation dialog instead of hard-failing:

- Title: `Open as Folder?`
- Body: `This folder is not a Git repository. Orca can open it for editing, terminal, and search, but Git-based features like worktrees, source control, pull requests, and checks will be unavailable.`
- Actions:
  - `Open Folder`
  - `Cancel`
  - optional: `Initialize Git Instead`

Why: users need to understand the capability downgrade before the folder is added to the workspace.

### Left Sidebar

A folder-mode repo should appear in the same left sidebar structure as existing repos, with one row underneath it:

- repo row
- one synthetic worktree row representing the folder

Recommended indicator:

- repo badge or row badge: `Folder` or `Non-Git`

The synthetic row should use a folder-specific subtitle treatment instead of an empty branch slot.

Recommendation:

- primary label: folder display name
- subtitle: `Folder` or a short path label

Do not style this as an error. It is a supported limited mode, not a broken state.

### Disabled / Hidden Git Features

Git-only features should either be hidden or disabled with an explanation.

Recommended behavior:

- `Create Worktree`: disabled or hidden for folder-mode repos
- `Delete Worktree`: do not reuse worktree-delete semantics for folder-mode rows
- Source Control tab: show inline empty state explaining git is required
- Checks tab: show inline empty state explaining a git branch / PR context is required
- branch/base-ref settings: hidden or disabled with explanation

Why: silent disappearance can feel broken. When users intentionally open a folder, the app should explain why a git surface is unavailable.

### Remove vs Delete Semantics

Folder mode must not reuse the current worktree deletion flow.

Recommendation:

- folder-mode row action: `Remove Folder from Orca`
- git worktree row action: `Delete Worktree`

Why: for real git worktrees, the current delete flow can remove filesystem content as part of worktree cleanup. Reusing that path for a synthetic folder row would be unsafe because users may intend to disconnect the folder from Orca, not delete the folder tree from disk.

### Settings Page

Keep folder-mode entries in the existing `Repositories` settings list, but show a type label:

- `Git`
- `Folder`

For folder-mode entries, keep generic settings:

- display name
- badge color
- remove from Orca

Hide or disable git-specific settings:

- default worktree base
- base ref picker/search
- branch-related settings
- PR/check-related settings

Recommended note near the top of a folder-mode settings card:

`Opened as folder. Git features are unavailable for this workspace.`

Why: the Settings page is where users will verify what Orca thinks this connected root is. The settings surface must stay consistent with the sidebar and runtime behavior.

The settings view should also skip eager git-specific checks for folder-mode repos, including hook-related checks unless folder hooks are explicitly supported.

## Functional Scope

### Should Work in Folder Mode

- add folder to Orca
- select the folder entry in the sidebar
- open terminal in that folder
- browse files
- read and edit files
- search files
- quick open files
- open external files within the authorized folder root
- restore terminal/editor session state against the synthetic worktree across app restarts

### Should Not Work in Folder Mode

- create additional worktrees
- remove git worktrees
- branch naming flows
- base branch selection
- git status / diff / stage / unstage / discard
- conflict and rebase state
- PR linking based on branch identity
- checks derived from PR head / branch
- git polling / refresh loops for source-control state

## Implementation Outline

### 1. Add Repo Type

Update the shared repo type to distinguish git repos from folder-mode repos.

Potential shape:

```ts
type Repo = {
  id: string
  path: string
  displayName: string
  badgeColor: string
  addedAt: number
  kind?: 'git' | 'folder'
  gitUsername?: string
  worktreeBaseRef?: string
  hookSettings?: RepoHookSettings
}
```

Why: existing persisted data may not have this field, so `git` should be treated as the default for backward compatibility.

### 2. Change Add-Repo Flow

Current behavior rejects non-git folders.

New behavior:

- detect whether selected path is git
- if yes, add as `kind: 'git'`
- if no, ask for confirmation and add as `kind: 'folder'` if accepted

This applies to:

- renderer add flow
- main-process `repos:add`
- runtime/CLI add flow if it should support folders too

### 3. Synthesize a Worktree for Folder Repos

Update worktree listing so folder-mode repos return a single synthetic worktree instead of `[]`.

This should apply to:

- `worktrees:list`
- `worktrees:listAll`
- any runtime-managed worktree listing APIs

Why: the app currently gates most of the workspace UI on `activeWorktreeId`. Returning no worktrees leaves the app stuck on the landing state even though the filesystem APIs could operate on the folder.

The synthetic worktree ID must be deterministic across restarts so session restore can reattach tabs, active selection, and terminal state correctly.

### 4. Suppress Git-Only Mutations

Guard git-only IPC and UI entry points for folder-mode repos:

- worktree creation
- worktree removal
- source control actions
- base ref queries/search
- branch-based PR/check flows where appropriate
- git status polling / conflict polling / branch compare refresh loops

These guards should fail clearly with a user-facing explanation when reached.

This must cover all create-worktree entry points, not just one visible button:

- landing page CTA
- keyboard shortcut
- add-worktree dialog repo picker / submit path
- any runtime or CLI create path that remains exposed

### 5. Update Sidebar and Settings Presentation

Add a neutral repo-type indicator in:

- left sidebar
- settings repo cards

Ensure git-only controls are hidden or disabled for folder mode.

### 6. Handle Search / Quick Open Fallbacks

Quick open and text search currently fall back to git-based commands when `rg` is unavailable.

Folder-mode support needs one of these decisions:

1. Require `rg` for folder mode and surface a clear error when it is unavailable.
2. Add non-git filesystem fallbacks for file listing and text search.

Recommendation: start with option 1 if we want a smaller implementation.

Why: the product value of folder mode is mainly unlocked on machines where `rg` exists. Non-git fallback walkers/searchers can be added later if needed.

If option 1 is chosen, the product should surface this clearly as a limitation rather than failing silently into empty quick-open or search results.

## Open Questions

### Hooks

Should `orca.yaml` hooks work for folder-mode repos?

Recommendation: do not include them in the initial scope unless there is a strong use case.

Reasoning: current hook behavior is designed around worktree creation/archive lifecycle, which folder mode does not have.

### CLI Semantics

Should the runtime/CLI also allow adding folder-mode repos, or should folder mode be UI-only at first?

Recommendation: keep CLI behavior aligned with the UI if feasible, but this can be phased.

If folder mode is UI-only initially, runtime and CLI commands should fail with an explicit folder-mode / unsupported message rather than the generic `Not a valid git repository`.

### Naming

Should the product call these `folders`, `workspaces`, or still `repositories`?

Recommendation: keep the top-level Settings section as `Repositories`, but label each entry as `Git` or `Folder`.

## Recommended Initial Scope

Ship the smallest coherent version:

- allow adding non-git folders
- show one synthetic worktree row per folder
- allow terminal, explorer, editor, search, and quick open
- show a persistent `Folder` indicator
- disable or hide git-only functionality
- document that worktrees, source control, PRs, and checks are unavailable

This provides immediate utility without trying to redefine Orca's core worktree-oriented architecture.

## Risks and Gaps

### Unsafe Deletion Path

The current worktree delete path should not be reused for folder mode.

Why: deleting a synthetic folder row via worktree removal semantics could remove the real folder contents from disk instead of just disconnecting it from Orca.

### Incomplete Create-Worktree Suppression

Worktree creation must be blocked at every entry point.

Why: if only one button is hidden, users can still reach the flow through shortcuts, the landing page, dialogs, or runtime/CLI paths and hit confusing git-only failures.

### Background Git Polling

Folder mode must opt out of git polling loops.

Why: repeated git status/conflict polling against a non-git folder would create noisy logs, unnecessary subprocess churn, and avoidable UI work.

### Stable Synthetic Identity

Synthetic worktree IDs must remain deterministic.

Why: session restore keys open tabs, active selection, and terminal reattachment off worktree identity.

### Sidebar Presentation

Folder rows need intentional presentation rather than inheriting blank branch UI.

Why: a technically valid row with no branch text will look unfinished and make the mode feel accidental.

### Settings / Hooks Ambiguity

Folder-mode settings must not eagerly present or execute git-specific controls/checks.

Why: the settings surface is the canonical place where users verify the capabilities of a connected root.

### Runtime / CLI Divergence

Folder support needs an explicit cross-surface decision.

Why: allowing folders in the UI but rejecting them in runtime/CLI without a clear explanation will create inconsistent product behavior.

### `rg` as a Practical Requirement

Folder mode depends on `rg` unless non-git fallbacks are added for quick-open and search.

Why: current fallback implementations use `git ls-files` and `git grep`, which do not work for non-git folders.

## Test Checklist

- add-folder confirmation flow
- persisted repo kind / backward compatibility
- synthetic worktree listing for folder repos
- deterministic synthetic worktree ID across restarts
- folder-mode session restore
- folder row uses `Remove Folder from Orca`, not worktree delete semantics
- create-worktree entry points are all gated for folder repos
- git polling is suppressed for folder repos
- settings sections are gated by repo kind
- folder sidebar row renders a non-branch subtitle
- runtime/CLI behavior is explicit for folder repos
- `rg`-missing behavior is covered for folder mode
