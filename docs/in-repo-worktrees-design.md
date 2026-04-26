# In-repo `.worktrees/` Mode

## Problem

Today, every worktree Orca creates lives in the global `workspaceDir` setting (default: `~/orca/workspaces`). For many users this is fine, but a real workflow gap exists for users who want to keep worktrees physically inside the project they belong to:

- Editor and tooling configs (linters, formatters, language servers) that expect a single root directory work more naturally when worktrees live under that root.
- Monorepo tooling that resolves paths relative to the repo (e.g. workspace globs in `pnpm-workspace.yaml`) breaks when worktrees are in an unrelated location.
- WSL users currently get a forced override that places worktrees under `<wslHome>/orca/workspaces` to avoid cross-filesystem performance traps. An in-repo `.worktrees/` directory satisfies the same constraint more cleanly because the worktree always inherits the repo's filesystem.
- Discovery and navigation: a user looking at a project on disk can find every linked worktree by listing one well-known subdirectory.

The convention of placing worktrees in a `.worktrees/` directory inside the repo (and gitignoring it) is established practice in the broader git community. Orca should support it as a first-class option.

## Goals

- Add an opt-in mode that creates new worktrees at `<repoPath>/.worktrees/<name>` instead of inside the global `workspaceDir`.
- Detect when the repo's `.gitignore` does not exclude `.worktrees/` and offer to fix it before creating the worktree.
- Preserve every existing worktree-creation behavior for users who do not opt in.
- Keep the persisted setting global and minimal (one new field on `GlobalSettings`).
- Use the smallest viable change to `computeWorktreePath` and the create flow, while taking the opportunity to fold the duplicated path-validation logic into one place.

## Non-goals

These are intentional omissions, each with rationale. They should not be added without revisiting this design.

1. **No automatic migration of existing worktrees** when toggling modes. Moving worktrees would invalidate user terminal sessions, editor tabs, and absolute paths in shell history. Users can `git worktree move` manually if they want to consolidate.
2. **No per-repo override.** The motivation is a workflow preference, not a per-repo property. Adding per-repo control later is non-breaking; we should not pay the cost upfront.
3. **No configurable directory name.** `.worktrees/` is the convention; the existing external mode is the escape hatch for anyone who needs a different layout. Configurability would add validation surface area against the path-traversal guard.
4. **No automatic `.gitignore` cleanup when toggling back to external mode.** The entry costs nothing when external mode is active, and removing it would surprise users who toggle in-repo mode back on later.
5. **No partial parser of git's full ignore-rule semantics.** Detection only needs to recognize the four canonical root-form patterns; everything else falls through to the prompt. Implementing the full rule grammar (negations across parent dirs, double-star globs, etc.) would be a significant undertaking with marginal user benefit.
6. **No "the .worktrees directory is empty, clean it up" UI affordance.** Empty directories are harmless; cleaning them up would surprise users who scripted around their presence.

## Decisions

| # | Decision | Choice |
|---|---|---|
| 1 | Scope | Global only — one new field on `GlobalSettings` |
| 2 | `.gitignore` handling | Detect and prompt — inline confirmation pane before create |
| 3 | Folder name | Fixed `.worktrees` (not configurable) |
| 4 | Settings UI | Two-tier segmented picker with conditional render |
| 5 | Persisted shape | String enum `'external' \| 'in-repo'` (not boolean) |
| 6 | WSL interaction | In-repo mode short-circuits the WSL special case |
| 7 | Folder/bare repos | In-repo path computation works; `.gitignore` prompt skipped |
| 8 | Path validation | Folded into `computeWorktreePath` (small refactor) |

## Architecture overview

The change touches four layers:

1. **Shared types and defaults** (`src/shared/types.ts`, `src/shared/constants.ts`) — adds the new `worktreeLocation` field.
2. **Path computation** (`src/main/ipc/worktree-logic.ts`) — adds the in-repo branch and folds in path-traversal validation.
3. **Gitignore detection / write** (new module `src/main/git/gitignore.ts`) — pure parsing plus IO wrappers, exposed via two new IPC handlers in `src/main/ipc/worktrees.ts`. Also adds a small `isBareRepo()` helper to `src/main/git/repo.ts` so the gitignore prompt can short-circuit on bare repos.
4. **Renderer UI** (`src/renderer/src/components/settings/GeneralPane.tsx`, `src/renderer/src/components/sidebar/AddWorktreeDialog.tsx`, plus the preload bridge in `src/preload/index.ts` and `src/preload/index.d.ts`) — settings picker, suggested-name pool fix, gitignore confirmation pane.

The filesystem-auth layer (`src/main/ipc/filesystem-auth.ts`) requires **no changes**, but the reasoning has two parts that should be understood together:

1. **`getAllowedRoots()`** (line 42) returns `repo.path` for every registered repo plus the global `workspaceDir`. Any descendant of `repo.path` — including `<repoPath>/.worktrees/<name>` — passes `isPathAllowed()` automatically. This is what allows the create flow's path-traversal guard to succeed.
2. **`rebuildAuthorizedRootsCache()`** (line 64) is called immediately after a successful create (`worktrees.ts:183`) to register the new worktree's normalized path in `registeredWorktreeRoots`. After this rebuild, the file explorer and quick-open IPCs can resolve the worktree via `resolveAuthorizedPath()` even if the realpath crosses a symlink.

For in-repo mode, point (1) is what matters at create time and point (2) is what matters at file-access time. Both already work as-needed; no auth code changes.

## Data model

A single new field on `GlobalSettings`:

```typescript
// src/shared/types.ts
export type WorktreeLocation = 'external' | 'in-repo'

export type GlobalSettings = {
  workspaceDir: string
  nestWorkspaces: boolean
  worktreeLocation: WorktreeLocation   // NEW
  // ... rest unchanged
}
```

```typescript
// src/shared/constants.ts — getDefaultSettings()
worktreeLocation: 'external',  // preserve current behavior for new + existing users
```

### Persistence migration

None required. `Store.load()` (`src/main/persistence.ts:62`) already shallow-merges defaults into stored settings on every load, so existing users automatically get `worktreeLocation: 'external'` injected on next launch. No schema bump.

### Why an enum and not a boolean

The UI is a segmented picker with two named modes today. A boolean (`placeWorktreesInRepo: true | false`) would not extend cleanly to a possible future third mode. The enum is also more readable in JSON dumps and tests, and matches the existing pattern used for `branchPrefix: 'git-username' | 'custom' | 'none'`.

### Settings that stay even when in-repo mode is active

`workspaceDir` and `nestWorkspaces` must remain in `getAllowedRoots()` and in the persisted state even when `worktreeLocation === 'in-repo'`:

- Pre-existing external worktrees still need filesystem-auth access.
- The user might toggle back to external mode and expect their previous settings to return.
- We never remove a root from the allowed list just because the future-default mode changed.

## Path computation

`computeWorktreePath` is refactored to add the in-repo branch and to absorb the path-traversal validation that currently lives in the calling code.

### New function shape

```typescript
// src/main/ipc/worktree-logic.ts
export function computeWorktreePath(
  sanitizedName: string,
  repoPath: string,
  settings: {
    nestWorkspaces: boolean
    workspaceDir: string
    worktreeLocation: WorktreeLocation
  }
): string {
  // In-repo mode runs first because it bypasses both the WSL special case
  // (worktrees inherit the repo's filesystem automatically) and the
  // user-configured workspaceDir (which is irrelevant when worktrees live
  // inside the repo).
  if (settings.worktreeLocation === 'in-repo') {
    const pathOps = looksLikeWindowsPath(repoPath) ? win32 : { basename, join }
    const worktreesRoot = pathOps.join(repoPath, '.worktrees')
    const candidate = pathOps.join(worktreesRoot, sanitizedName)
    return ensurePathWithinWorkspace(candidate, worktreesRoot)
  }

  // ... existing WSL branch (unchanged) — also wraps its result in
  // ensurePathWithinWorkspace against <wslHome>/orca/workspaces ...

  // ... existing external flat/nested branch — also wraps its result in
  // ensurePathWithinWorkspace against settings.workspaceDir ...
}
```

### Calling-code simplification

`worktrees.ts:134-142` is **deleted in its entirety** (the WSL root computation, the `wslHome` lookup, and the standalone `ensurePathWithinWorkspace(worktreePath, workspaceRoot)` call) and replaced with a single line:

```typescript
// Before — lines 134-142 of worktrees.ts (DELETE all of this):
let worktreePath = computeWorktreePath(sanitizedName, repo.path, settings)
const wslInfo = isWslPath(repo.path) ? parseWslPath(repo.path) : null
const wslHome = wslInfo ? getWslHome(wslInfo.distro) : null
const workspaceRoot = wslHome ? join(wslHome, 'orca', 'workspaces') : settings.workspaceDir
worktreePath = ensurePathWithinWorkspace(worktreePath, workspaceRoot)

// After:
const worktreePath = computeWorktreePath(sanitizedName, repo.path, settings)
```

**Critical:** the standalone `ensurePathWithinWorkspace` call on line 142 must be removed when this refactor lands. Leaving it in place would cause every in-repo create to fail with `'Invalid worktree path'`, because `<repoPath>/.worktrees/<name>` is not a descendant of `settings.workspaceDir`. This is a single-edit change but easy to miss in a code review — the refactor PR description should explicitly call it out.

After the refactor, the now-unused `parseWslPath`, `getWslHome`, `isWslPath`, and `join` imports in `worktrees.ts` should be removed if they have no other call sites in the file (verify before removing).

### Why fold validation into the function

The validation root (`workspaceDir` in external mode, `<wslHome>/orca/workspaces` in WSL mode, `<repoPath>/.worktrees` in in-repo mode) is currently computed in two places. Adding the in-repo branch would force a third mode in *both* the path computation and the calling code. Folding validation into `computeWorktreePath` keeps the rule "the workspace root for mode X is Y" in one well-tested place.

The function stays pure and synchronous. Throwing on path traversal is the expected failure mode.

### Net-new behavior to be aware of: WSL branch validation

Today, the WSL branch in `computeWorktreePath` (lines 78-95) builds a path and returns it directly — it never calls `ensurePathWithinWorkspace`. The path-traversal check only runs in the calling code (`worktrees.ts:142`) against the WSL workspace root.

After the refactor, the WSL branch will run `ensurePathWithinWorkspace` *internally* against `<wslHome>/orca/workspaces` before returning. This is **net-new validation behavior on the WSL path**, not a relocation. It carries a small regression risk: if there's any pre-existing user state where a WSL worktree was previously placed in a way that the validation would now reject, the create would start failing.

The risk is low because `sanitizeWorktreeName` already strips traversal sequences, and the WSL branch already builds paths from sanitized inputs. But the spec must ship a regression test that exercises the WSL external path with the new validation in place — see the test addition at the end of this section.

**Required regression test in `worktree-logic-wsl.test.ts`:**

```typescript
it('still validates WSL external paths against <wslHome>/orca/workspaces after refactor', () => {
  // Sanity check: the validation now lives inside computeWorktreePath, but
  // the WSL external mode must still produce valid paths and reject bad ones.
  expect(
    computeWorktreePath('feature', '\\\\wsl.localhost\\Ubuntu\\home\\user\\myrepo', {
      nestWorkspaces: true,
      workspaceDir: 'C:\\workspaces',
      worktreeLocation: 'external'
    })
  ).toBe('\\\\wsl.localhost\\Ubuntu\\home\\user\\orca\\workspaces\\myrepo\\feature')
  // Adjust expectation to match actual existing WSL test fixtures.
})
```

### Edge cases handled implicitly

- **WSL repos in in-repo mode** → `repoPath` is already a `\\wsl.localhost\...` UNC path, so `<repoPath>/.worktrees/<name>` is automatically on the WSL filesystem. The WSL special case is skipped.
- **Windows repos in in-repo mode** → `looksLikeWindowsPath(repoPath)` returns true, so `win32` path operations are used; backslash separators are preserved.
- **Bare repos** → `git worktree add` works fine for bare repos; the `.worktrees/` directory becomes a sibling of the bare repo's git data. The `.gitignore` prompt is skipped at the IPC layer (see below).
- **Nested worktrees** (creating from inside an existing worktree) → already handled because `worktrees:create` looks up `repo.path` from the store, which is always the main worktree path, never the active worktree.

## Gitignore detection and write

A new module with three pieces: pure parsing logic, IO wrappers, and two IPC handlers.

### File: `src/main/git/gitignore.ts` (new)

#### Pure parsing — testable without fs mocking

```typescript
const ROOT_WORKTREES_PATTERNS = new Set([
  '.worktrees',
  '.worktrees/',
  '/.worktrees',
  '/.worktrees/'
])

export function isWorktreesDirIgnoredByGitignore(content: string | null): boolean {
  if (content == null) return false
  // Why no .trim() per line: git treats leading whitespace as part of the
  // pattern (so `\t.worktrees/` is a literal filename, not an ignored dir),
  // and trailing spaces are significant unless escaped. A trim() would
  // produce false negatives where Orca reports "already ignored" for malformed
  // entries that git would treat as literal filenames. Exact-string matching
  // against the canonical patterns is safer and matches git's behavior. The
  // `\r?\n` split already strips Windows CRLF line endings, so individual
  // lines never carry `\r`.
  for (const line of content.split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue
    // Why skip negations: a `!.worktrees/` line could un-ignore the directory.
    // Treating it as "ignored" would suppress the prompt and surprise the user.
    // Treating any negation as "not ignored" is the safer default — they get
    // the prompt and can opt out if their config is intentional.
    if (line.startsWith('!')) continue
    if (ROOT_WORKTREES_PATTERNS.has(line)) return true
  }
  return false
}

export function appendWorktreesEntry(content: string | null): string {
  const base = content ?? ''
  const needsLeadingNewline = base.length > 0 && !base.endsWith('\n')
  return base + (needsLeadingNewline ? '\n' : '') + '.worktrees/\n'
}
```

#### IO wrappers

```typescript
export async function readGitignore(repoPath: string): Promise<string | null> {
  try {
    return await readFile(join(repoPath, '.gitignore'), 'utf-8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

export async function isWorktreesDirIgnored(repoPath: string): Promise<boolean> {
  return isWorktreesDirIgnoredByGitignore(await readGitignore(repoPath))
}

export async function addWorktreesDirToGitignore(repoPath: string): Promise<void> {
  const content = await readGitignore(repoPath)
  // Idempotent: a racing second click or rapid second create must not
  // duplicate the entry. Re-check before writing rather than trusting the
  // renderer to call this only when needed.
  if (isWorktreesDirIgnoredByGitignore(content)) return
  await writeFile(join(repoPath, '.gitignore'), appendWorktreesEntry(content), 'utf-8')
}
```

### New helper: `isBareRepo()` in `src/main/git/repo.ts`

The bare-repo short-circuit needs a small helper that doesn't exist today. The existing `isGitRepo()` function (`src/main/git/repo.ts:10`) already calls `git rev-parse --is-bare-repository` internally for fallback detection; we just expose that one-liner separately:

```typescript
// src/main/git/repo.ts
export function isBareRepo(repoPath: string): boolean {
  try {
    const result = gitExecFileSync(['rev-parse', '--is-bare-repository'], {
      cwd: repoPath
    }).trim()
    return result === 'true'
  } catch {
    return false
  }
}
```

Sync (matches the rest of `repo.ts`), fast (one git invocation), and safe to call from any IPC handler.

### IPC handlers (registered in `src/main/ipc/worktrees.ts`)

Two new handlers, registered alongside the existing worktree handlers. They mirror the `hooks:check` pattern (small handlers, create-flow-adjacent).

```typescript
ipcMain.handle('gitignore:checkWorktreesIgnored', async (_event, args: { repoId: string }) => {
  const repo = store.getRepo(args.repoId)
  // Folder repos can't have worktrees, and bare repos have no working tree
  // to dirty. In both cases, treat as already-handled to short-circuit any
  // UI gating in the renderer.
  if (!repo || isFolderRepo(repo) || isBareRepo(repo.path)) {
    return { ignored: true }
  }
  try {
    return { ignored: await isWorktreesDirIgnored(repo.path) }
  } catch (error) {
    console.warn('[gitignore] read failed for', repo.path, error)
    // Why fail-open (return ignored: false) instead of fail-closed: a closed
    // failure would silently suppress the prompt and the user could end up
    // with thousands of untracked worktree files in `git status` without
    // ever knowing why. Open failure shows the prompt; user decides.
    return { ignored: false }
  }
})

ipcMain.handle('gitignore:addWorktreesEntry', async (_event, args: { repoId: string }) => {
  const repo = store.getRepo(args.repoId)
  if (!repo || isFolderRepo(repo)) {
    throw new Error('Cannot modify .gitignore for this repo type.')
  }
  await addWorktreesDirToGitignore(repo.path)
})
```

### Why two IPCs and not one combined `worktrees:createWithGitignore`

The user's three choices in the confirmation pane (Add and create / Create anyway / Cancel) need to be resolved **before** calling the irreversible `worktrees:create`. Two thin handlers keep each one focused and the create handler unchanged. The renderer orchestrates the sequence.

## Create flow & `AddWorktreeDialog` wiring

Three changes in the renderer.

### Preload bridge

Two files to touch — implementation in `src/preload/index.ts` (the new namespace lives next to the existing `hooks: { ... }` block at line 307) and types in `src/preload/index.d.ts` (next to the existing `HooksApi` type at line 136).

```typescript
// src/preload/index.ts — add next to the existing `hooks: { check: ... }` block
gitignore: {
  checkWorktreesIgnored: (args: { repoId: string }): Promise<{ ignored: boolean }> =>
    ipcRenderer.invoke('gitignore:checkWorktreesIgnored', args),
  addWorktreesEntry: (args: { repoId: string }): Promise<void> =>
    ipcRenderer.invoke('gitignore:addWorktreesEntry', args)
},
```

```typescript
// src/preload/index.d.ts — add next to the existing HooksApi type at line 136
type GitignoreApi = {
  checkWorktreesIgnored: (args: { repoId: string }) => Promise<{ ignored: boolean }>
  addWorktreesEntry: (args: { repoId: string }) => Promise<void>
}
```

**Then** add `gitignore: GitignoreApi` to the main `Api` type at `src/preload/index.d.ts:264`, next to the existing `hooks: HooksApi` line. Forgetting this second step means the renderer's TypeScript will not see the new namespace and `window.api.gitignore.*` calls will be `any`-typed.

### Gating `handleCreate`

Split the existing `handleCreate` into `handleCreate` (decides what to do) and `performCreate` (does it). The split makes the new gating logic readable and lets the confirmation pane buttons call straight into the action.

```typescript
const [pendingGitignoreConfirm, setPendingGitignoreConfirm] = useState(false)

const handleCreate = useCallback(async () => {
  if (!repoId || !name.trim() || shouldWaitForSetupCheck || !selectedRepo) return

  // In-repo mode is the only mode that touches .gitignore. External mode
  // creates worktrees outside the repo, so the file is irrelevant.
  if (settings?.worktreeLocation === 'in-repo') {
    try {
      const { ignored } = await window.api.gitignore.checkWorktreesIgnored({ repoId })
      if (!ignored) {
        setPendingGitignoreConfirm(true)
        return  // wait for user to pick from the confirmation pane
      }
    } catch (error) {
      // Why: a failed check must NOT block create. Falling through is the
      // same outcome as "ignored: true" — the worktree gets created and
      // .gitignore stays untouched. Worst case: untracked files in git
      // status, which the user can fix manually.
      console.warn('[create] gitignore check failed, proceeding:', error)
    }
  }

  await performCreate({ addGitignoreEntry: false })
}, [
  // All existing handleCreate deps PLUS:
  repoId,                           // used in the gitignore check call
  settings?.worktreeLocation,       // gates whether the check runs at all
  performCreate                     // the new entry point
])

const performCreate = useCallback(
  async ({ addGitignoreEntry }: { addGitignoreEntry: boolean }) => {
    setCreateError(null)
    setCreating(true)
    try {
      if (addGitignoreEntry) {
        try {
          await window.api.gitignore.addWorktreesEntry({ repoId })
        } catch (error) {
          // Why degrade to a warning instead of failing: the worktree create
          // hasn't happened yet, but failing here would strand the user
          // without any worktree at all over a non-fatal file write. A
          // warning toast is honest and lets the create proceed.
          toast.warning('Could not update .gitignore — creating worktree anyway.', {
            description: error instanceof Error ? error.message : undefined
          })
        }
      }
      // ... existing create flow: createWorktree, updateWorktreeMeta,
      // navigation, ensureWorktreeHasInitialTerminal, revealWorktreeInSidebar ...
    } finally {
      setCreating(false)
      setPendingGitignoreConfirm(false)
    }
  },
  [
    // performCreate inherits the existing handleCreate dep list (all 18
    // entries from lines 204-228 of the current file) and adds:
    repoId,                           // used in addWorktreesEntry call
    setPendingGitignoreConfirm        // reset on completion
  ]
)
```

**Why being explicit about deps matters here:** the existing `handleCreate` has 18 entries in its dep array. Splitting it into two `useCallback`s without rewiring deps carefully will trip ESLint's `react-hooks/exhaustive-deps` rule and, worse, may cause stale closures where `repoId` captures the value at the time the dialog opened rather than when the user clicks the confirmation pane button. Both new callbacks must be re-evaluated when `repoId` changes.

### Inline confirmation pane

When `pendingGitignoreConfirm` is true, the dialog body is replaced with the confirmation prompt. The dialog title and chrome stay the same so it feels like a step in the flow, not a separate modal.

```tsx
{pendingGitignoreConfirm ? (
  <div className="space-y-3">
    <DialogHeader>
      <DialogTitle className="text-sm">Add `.worktrees/` to `.gitignore`?</DialogTitle>
      <DialogDescription className="text-xs">
        This repo doesn&apos;t ignore <code>.worktrees/</code>. Without this
        entry, every file in your new worktree will appear as untracked
        changes in <code>git status</code>.
      </DialogDescription>
    </DialogHeader>
    <DialogFooter className="gap-2">
      <Button
        variant="outline"
        size="sm"
        onClick={() => setPendingGitignoreConfirm(false)}  // back to form
      >
        Cancel
      </Button>
      <Button
        variant="outline"
        size="sm"
        onClick={() => performCreate({ addGitignoreEntry: false })}
      >
        Create anyway
      </Button>
      <Button
        size="sm"
        onClick={() => performCreate({ addGitignoreEntry: true })}
      >
        Add and create
      </Button>
    </DialogFooter>
  </div>
) : (
  /* existing form body unchanged */
)}
```

### Why an inline pane and not a stacked modal

The shadcn `Dialog` is already mounted; layering a second `AlertDialog` on top creates focus-trap issues and looks visually noisy. Replacing the form body in place keeps the user in one dialog and makes the back-out (Cancel) feel like a step back, not a separate modal dismissal.

### Suggested-name pool fix

The existing logic uses `nestWorkspaces` to decide whether name conflicts are per-repo or global:

```typescript
const suggestedName = useMemo(
  () => getSuggestedSpaceName(repoId, worktreesByRepo, settings?.nestWorkspaces ?? false),
  [repoId, worktreesByRepo, settings?.nestWorkspaces]
)
```

In in-repo mode, each repo has its own `.worktrees/` directory, so name conflicts are also per-repo. Update the call site to pass a derived flag and rename the parameter to describe its effect rather than its cause:

```typescript
// In-repo mode and nested external mode both have per-repo name pools.
// Only flat external mode shares names across all repos.
const namePoolIsPerRepo =
  settings?.worktreeLocation === 'in-repo' || (settings?.nestWorkspaces ?? false)

const suggestedName = useMemo(
  () => getSuggestedSpaceName(repoId, worktreesByRepo, namePoolIsPerRepo),
  [repoId, worktreesByRepo, namePoolIsPerRepo]
)
```

The function's third parameter gets renamed from `nestWorkspaces` to `perRepoNamePool` to reflect what it actually controls.

### Reset on dialog close

The existing `useEffect` at `AddWorktreeDialog.tsx:267-296` schedules a 200ms-delayed reset of all dialog state when `isOpen` flips false. Add `setPendingGitignoreConfirm(false)` to that reset callback (alongside `setRepoId('')`, `setName('')`, etc.). The Cancel button in the confirmation pane resets it immediately and synchronously, so the delayed reset is just a safety net for the close-via-Escape / close-via-X paths.

## Settings UI in `GeneralPane`

The Workspace section gets a new segmented control at the top, and the existing `Workspace Directory` + `Nest Workspaces` controls render conditionally below it.

### New shape

```
Workspace
  ├─ Worktree Location    [External directory | In-repo .worktrees/]
  └─ (when External:)
  │    ├─ Workspace Directory  [text input + Browse]
  │    └─ Nest Workspaces       [toggle]
  └─ (when In-repo:)
       └─ "Worktrees will be created at <repo>/.worktrees/<name>.
           Orca will offer to add `.worktrees/` to your repo's
           .gitignore on first create."
```

### Implementation

Mirrors the existing `branchPrefix` segmented control (`GeneralPane.tsx:290-308`):

```tsx
<SearchableSetting
  title="Worktree Location"
  description="Where Orca creates new worktree directories."
  keywords={['worktree', 'location', 'in-repo', '.worktrees', 'external', 'workspace']}
  className="space-y-2"
>
  <Label>Worktree Location</Label>
  <div className="flex w-fit gap-1 rounded-md border border-border/50 p-1">
    {(
      [
        ['external', 'External directory'],
        ['in-repo', 'In-repo .worktrees/']
      ] as const
    ).map(([value, label]) => (
      <button
        key={value}
        onClick={() => updateSettings({ worktreeLocation: value })}
        className={`rounded-sm px-3 py-1 text-sm transition-colors ${
          settings.worktreeLocation === value
            ? 'bg-accent font-medium text-accent-foreground'
            : 'text-muted-foreground hover:text-foreground'
        }`}
      >
        {label}
      </button>
    ))}
  </div>
  <p className="text-xs text-muted-foreground">
    {settings.worktreeLocation === 'in-repo' ? (
      <>
        New worktrees will be created at{' '}
        <code>&lt;repo&gt;/.worktrees/&lt;name&gt;</code>. Orca will offer to
        add <code>.worktrees/</code> to each repo&apos;s <code>.gitignore</code>
        on first create.
      </>
    ) : (
      'New worktrees will be created in the workspace directory below.'
    )}
  </p>
</SearchableSetting>

{settings.worktreeLocation === 'external' ? (
  <>
    {/* existing Workspace Directory SearchableSetting unchanged */}
    {/* existing Nest Workspaces SearchableSetting unchanged */}
  </>
) : null}
```

### Search keyword updates

Add a new entry to `GENERAL_WORKSPACE_SEARCH_ENTRIES` in `src/renderer/src/components/settings/general-search.ts` so the picker is discoverable from the global settings search:

```typescript
{
  title: 'Worktree Location',
  description: 'Where Orca creates new worktree directories.',
  keywords: ['worktree', 'location', 'in-repo', '.worktrees', 'external', 'workspace', 'gitignore']
}
```

### Why hide the disabled controls instead of greying them out

The visual difference between "this control is irrelevant" and "this control is broken" is too subtle when both are still rendered. Hiding makes it unambiguous: in in-repo mode, those settings simply don't exist. The persisted values are untouched — toggling back to External mode brings them back exactly as they were.

## Tests

### `src/main/ipc/worktree-logic.test.ts` — additions

```typescript
describe('computeWorktreePath in in-repo mode', () => {
  it('places worktree under <repo>/.worktrees/<name>', () => {
    expect(
      computeWorktreePath('feature', '/repos/my-project', {
        nestWorkspaces: true,
        workspaceDir: '/workspaces',
        worktreeLocation: 'in-repo'
      })
    ).toBe(join('/repos/my-project', '.worktrees', 'feature'))
  })

  it('ignores nestWorkspaces and workspaceDir when in-repo mode is on', () => {
    // Regression guard: in-repo must short-circuit before any external-mode logic.
    expect(
      computeWorktreePath('feature', '/repos/my-project', {
        nestWorkspaces: false,
        workspaceDir: '/some/other/path',
        worktreeLocation: 'in-repo'
      })
    ).toBe(join('/repos/my-project', '.worktrees', 'feature'))
  })

  it('uses Windows path operations for a Windows repo path', () => {
    expect(
      computeWorktreePath('feature', 'C:\\repos\\my-project', {
        nestWorkspaces: true,
        workspaceDir: 'C:\\workspaces',
        worktreeLocation: 'in-repo'
      })
    ).toBe('C:\\repos\\my-project\\.worktrees\\feature')
  })

  it('uses WSL UNC path under .worktrees for a WSL repo', () => {
    // Critical: in-repo mode must NOT trigger the WSL workspace override.
    expect(
      computeWorktreePath('feature', '\\\\wsl.localhost\\Ubuntu\\home\\user\\myrepo', {
        nestWorkspaces: true,
        workspaceDir: 'C:\\workspaces',
        worktreeLocation: 'in-repo'
      })
    ).toBe('\\\\wsl.localhost\\Ubuntu\\home\\user\\myrepo\\.worktrees\\feature')
  })

  it('throws on path traversal attempts in in-repo mode', () => {
    expect(() =>
      computeWorktreePath('../escape', '/repos/my-project', {
        nestWorkspaces: true,
        workspaceDir: '/workspaces',
        worktreeLocation: 'in-repo'
      })
    ).toThrow('Invalid worktree path')
  })
})

describe('computeWorktreePath external mode regression guards', () => {
  it('still nests under repo name when worktreeLocation is external', () => {
    // Lock in that adding the new field did not perturb the default flow.
    expect(
      computeWorktreePath('feature', '/repos/my-project', {
        nestWorkspaces: true,
        workspaceDir: '/workspaces',
        worktreeLocation: 'external'
      })
    ).toBe(join('/workspaces', 'my-project', 'feature'))
  })
})
```

### `src/main/git/gitignore.test.ts` (new file)

```typescript
describe('isWorktreesDirIgnoredByGitignore', () => {
  it('returns false for null content (no .gitignore file)', () => { /* ... */ })
  it('returns false for empty content', () => { /* ... */ })
  it('recognizes .worktrees/', () => { /* ... */ })
  it('recognizes .worktrees (no trailing slash)', () => { /* ... */ })
  it('recognizes /.worktrees/', () => { /* ... */ })
  it('recognizes /.worktrees', () => { /* ... */ })
  it('recognizes the entry among unrelated lines', () => { /* ... */ })
  it('ignores comment lines', () => { /* ... */ })
  it('ignores negation rules (!.worktrees/)', () => { /* ... */ })
  it('does not false-positive on substring matches (.worktrees-cache/)', () => { /* ... */ })
  it('handles CRLF line endings (\\r is stripped by the split regex)', () => { /* ... */ })
  it('does NOT match leading-whitespace patterns (\\t.worktrees/)', () => {
    // Regression guard: an earlier draft of the parser called .trim() per line,
    // which incorrectly matched indented lines that git would treat as literal
    // filenames. The current parser is exact-string only — assert this stays.
  })
  it('does NOT match trailing-whitespace patterns (.worktrees/ )', () => {
    // Same regression guard for trailing whitespace, which git treats as
    // significant unless escaped.
  })
})

describe('appendWorktreesEntry', () => {
  it('appends to empty content', () => { /* ... */ })
  it('appends to null content', () => { /* ... */ })
  it('adds a leading newline when prior content does not end with one', () => { /* ... */ })
  it('does not add a duplicate newline when prior content ends with one', () => { /* ... */ })
})
```

### `src/main/ipc/worktrees.test.ts` — additions

```typescript
describe('gitignore:checkWorktreesIgnored', () => {
  it('returns ignored: true when .gitignore contains .worktrees/', async () => { /* ... */ })
  it('returns ignored: false when .gitignore is missing', async () => { /* ... */ })
  it('returns ignored: false when .gitignore lacks the entry', async () => { /* ... */ })
  it('returns ignored: true for folder repos (no-op short-circuit)', async () => { /* ... */ })
  it('returns ignored: true for bare repos (no-op short-circuit)', async () => { /* ... */ })
  it('returns ignored: false on read error (fail-open)', async () => { /* ... */ })
})

describe('gitignore:addWorktreesEntry', () => {
  it('creates .gitignore with the entry when missing', async () => { /* ... */ })
  it('appends the entry to an existing .gitignore', async () => { /* ... */ })
  it('is idempotent — does not duplicate when entry already present', async () => { /* ... */ })
  it('throws for folder repos', async () => { /* ... */ })
})
```

The IPC handler tests are deliberately skeletal compared to the pure-parsing tests: the value lives in the pure logic. The IPC tests just confirm the wiring; if the pure logic is right, there's not much that can go wrong in 5-line handlers.

## Edge cases

| Case | Behavior | Why |
|---|---|---|
| `.worktrees/` already exists as a tracked directory | `git worktree add` fails with its own error message; surface verbatim through the existing create error path | Don't duplicate git's validation. Its error is more accurate than anything we could synthesize. |
| `.gitignore` is read-only / write fails | Renderer toasts a warning ("Could not update .gitignore — creating worktree anyway") and proceeds with the create | The worktree is the primary thing the user wanted; the gitignore tweak is the secondary. Failing the create over a secondary file write would be the wrong trade. |
| Bare repo in in-repo mode | The IPC handler short-circuits `gitignore:checkWorktreesIgnored` to `{ ignored: true }` so the prompt never fires | Bare repos have no working tree to dirty, so the `.gitignore` concern is moot. The worktree itself still gets created at `<bareRepoPath>/.worktrees/<name>`. |
| Folder repo (non-git) in in-repo mode | The create handler already throws `'Folder mode does not support creating worktrees.'` | No new handling needed; the existing guard covers it. |
| User toggles external → in-repo with existing external worktrees | Existing worktrees stay where they are; only future creates use the new mode | The setting governs creation, not migration. Moving worktrees would invalidate user terminal sessions, editor tabs, and absolute paths in shell history. |
| User has both modes' worktrees in one repo | Both render in the sidebar; both work normally | `git worktree list` is the source of truth for what exists; our settings only choose where new ones land. |
| `.worktrees/` is a symlink (e.g. to a separate fast disk) | Worktree gets created inside the symlink target; existing `realpath` resolution in `filesystem-auth.ts` handles authorization | The symlink-target case is no different from any other symlinked subdirectory in a repo today; we don't need a special rule. |
| User has the entry commented out (`# .worktrees/`) | Prompt fires anyway, asking if they want to add the entry | The parser intentionally ignores comment lines per the non-goal on full ignore-rule semantics. A user who explicitly commented out the entry can pick "Create anyway" once and Orca won't modify their file. Treating this as a known false-positive is cheaper than implementing comment-aware logic. |
| Settings search returns hidden controls | When the user is in in-repo mode and searches "workspace directory" or "nest workspaces", the search match still highlights the Workspace section but the controls are hidden | Acceptable mismatch. The Workspace section header and the location picker remain visible, so the user can immediately see why the searched-for control isn't there. Conditionally excluding entries from `GENERAL_WORKSPACE_SEARCH_ENTRIES` based on the current mode would couple search registration to runtime state, which is inconsistent with the rest of the search-entry pattern. |

## Implementation order

A suggested order for the writing-plans skill, optimized so each step compiles and tests pass before moving on:

1. **Types and defaults** — Add `WorktreeLocation` type, add `worktreeLocation` to `GlobalSettings`, set the default in `getDefaultSettings()`. No behavior changes; should be invisible to existing code.
2. **`isBareRepo()` helper** — Add the small sync helper to `src/main/git/repo.ts`. No callers yet.
3. **`gitignore.ts` module + tests** — Pure parsing functions and IO wrappers, fully tested. No callers yet.
4. **`computeWorktreePath` refactor + tests** — Add the in-repo branch, fold in path validation, add the new test cases. Update the calling code in `worktrees.ts:134-142` to use the new single-line shape.
5. **IPC handlers** — Register `gitignore:checkWorktreesIgnored` and `gitignore:addWorktreesEntry` in `worktrees.ts`; wire in the bare-repo and folder-repo short-circuits; add IPC handler tests.
6. **Preload bridge** — Add `gitignore` namespace to `src/preload/index.ts` and the matching `GitignoreApi` type to `src/preload/index.d.ts`.
7. **`AddWorktreeDialog` wiring** — Split `handleCreate` into `handleCreate` + `performCreate`; add the gitignore gate; add the inline confirmation pane; rename and update the suggested-name pool flag; add the dialog state reset.
8. **`GeneralPane` settings UI** — Add the segmented picker, conditionally render the existing controls, update `general-search.ts`.
9. **Manual smoke test** — Toggle the setting, create a worktree in each mode, verify the prompt fires, verify `.gitignore` gets the entry exactly once, verify the existing external flow is unchanged.
