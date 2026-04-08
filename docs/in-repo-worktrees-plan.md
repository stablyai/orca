# In-repo `.worktrees/` Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an opt-in global setting that creates new git worktrees at `<repoPath>/.worktrees/<name>` instead of inside the global `workspaceDir`, with automatic `.gitignore` prompting.

**Architecture:** Single new `GlobalSettings.worktreeLocation: 'external' | 'in-repo'` field. Path computation refactor in `computeWorktreePath` folds the three modes (external-flat, external-nested, in-repo) into one function with internal validation. A new `gitignore.ts` module owns parse/write logic. Two new IPC handlers (`gitignore:checkWorktreesIgnored`, `gitignore:addWorktreesEntry`) gate the create flow. `AddWorktreeDialog` splits `handleCreate` into decision/action halves and shows an inline confirmation pane when the repo's `.gitignore` is missing the entry. `GeneralPane` gets a two-option segmented picker at the top of the Workspace section.

**Tech Stack:** TypeScript, Electron, React (renderer), Vitest, pnpm, oxlint.

**Reference spec:** `docs/in-repo-worktrees-design.md`

---

## Pre-flight

Confirm the working directory is clean and you can run the test suite before starting.

- [ ] **Step 0.1: Verify the spec is present and the tree is clean**

Run:
```bash
ls docs/in-repo-worktrees-design.md
git status
```

Expected: the design doc exists, working tree is clean (or only contains this plan file).

- [ ] **Step 0.2: Baseline test run**

Run:
```bash
pnpm test
```

Expected: all existing tests pass. If any fail, **stop** — fix or report before proceeding. Every later task assumes a green baseline.

- [ ] **Step 0.3: Baseline typecheck**

Run:
```bash
pnpm run tc
```

Expected: all three projects typecheck clean.

---

## Task 1: Add `WorktreeLocation` type and default

**Files:**
- Modify: `src/shared/types.ts` (add type + field to `GlobalSettings`)
- Modify: `src/shared/constants.ts` (add default in `getDefaultSettings`)

**Why this first:** The new field must exist before any code reads it. Doing this alone should be invisible to the rest of the system — the typecheck is the only gate.

- [ ] **Step 1.1: Add the `WorktreeLocation` type and field**

Open `src/shared/types.ts` and locate the `GlobalSettings` type (around line 287). Add the `WorktreeLocation` type alias **above** `GlobalSettings` and the new field **after** `nestWorkspaces`:

```typescript
// Add this type alias directly above `export type GlobalSettings`
export type WorktreeLocation = 'external' | 'in-repo'

export type GlobalSettings = {
  workspaceDir: string
  nestWorkspaces: boolean
  worktreeLocation: WorktreeLocation
  branchPrefix: 'git-username' | 'custom' | 'none'
  // ... rest unchanged
}
```

- [ ] **Step 1.2: Add the default in `getDefaultSettings`**

Open `src/shared/constants.ts` and locate `getDefaultSettings` (around line 60). Add the new field right after `nestWorkspaces: true,`:

```typescript
export function getDefaultSettings(homedir: string): GlobalSettings {
  return {
    workspaceDir: `${homedir}/orca/workspaces`,
    nestWorkspaces: true,
    worktreeLocation: 'external',
    branchPrefix: 'git-username',
    // ... rest unchanged
  }
}
```

- [ ] **Step 1.3: Update the two known test fixtures that construct `GlobalSettings`-shaped objects**

Two IPC tests construct settings fixtures that will fail typecheck as soon as the new field is required. Update both:

**File 1:** `src/main/ipc/worktrees.test.ts` around line 151. Change:

```typescript
store.getSettings.mockReturnValue({
  branchPrefix: 'none',
  nestWorkspaces: false,
  workspaceDir: '/workspace'
})
```

to:

```typescript
store.getSettings.mockReturnValue({
  branchPrefix: 'none',
  nestWorkspaces: false,
  workspaceDir: '/workspace',
  worktreeLocation: 'external'
})
```

**File 2:** `src/main/ipc/worktrees-windows.test.ts` around line 154. Change:

```typescript
store.getSettings.mockReturnValue({
  branchPrefix: 'none',
  nestWorkspaces: false,
  workspaceDir: 'C:\\workspaces'
})
```

to:

```typescript
store.getSettings.mockReturnValue({
  branchPrefix: 'none',
  nestWorkspaces: false,
  workspaceDir: 'C:\\workspaces',
  worktreeLocation: 'external'
})
```

- [ ] **Step 1.4: Typecheck passes**

Run:
```bash
pnpm run tc
```

Expected: all three projects compile clean. If any other call site fails, it's because another test fixture or call site constructs a `GlobalSettings`-shaped object. Grep for them:

```bash
grep -rn "workspaceDir.*nestWorkspaces\|nestWorkspaces.*workspaceDir" src/
```

Add `worktreeLocation: 'external'` to each hit.

- [ ] **Step 1.5: Existing tests pass**

Run:
```bash
pnpm test
```

Expected: all green.

- [ ] **Step 1.6: Commit**

```bash
git add src/shared/types.ts src/shared/constants.ts \
  src/main/ipc/worktrees.test.ts src/main/ipc/worktrees-windows.test.ts
# Add any other test fixtures you updated in Step 1.4
git commit -m "feat: add WorktreeLocation setting field (default: external)"
```

---

## Task 2: Add `isBareRepo()` helper

**Files:**
- Modify: `src/main/git/repo.ts` (add new sync helper)
- Modify (test): `src/main/git/repo.test.ts` (may be new file)

**Why:** The gitignore IPC handler needs to short-circuit bare repos. The existing `isGitRepo()` already knows how to detect bareness internally; we expose that one-liner.

- [ ] **Step 2.1: Check whether a test file exists**

Run:
```bash
ls src/main/git/repo.test.ts 2>&1
```

If it doesn't exist, create it in Step 2.2 with the imports block. If it exists, append to the existing file.

- [ ] **Step 2.2: Write the failing test**

Create or modify `src/main/git/repo.test.ts`. The test calls `isBareRepo()` with a path — we mock `gitExecFileSync` since the real binary shouldn't run in tests.

```typescript
import { describe, expect, it, vi, beforeEach } from 'vitest'

const { gitExecFileSyncMock } = vi.hoisted(() => ({
  gitExecFileSyncMock: vi.fn()
}))

vi.mock('./runner', () => ({
  gitExecFileSync: gitExecFileSyncMock,
  gitExecFileAsync: vi.fn()
}))

import { isBareRepo } from './repo'

describe('isBareRepo', () => {
  beforeEach(() => {
    gitExecFileSyncMock.mockReset()
  })

  it('returns true when git rev-parse reports the repo is bare', () => {
    gitExecFileSyncMock.mockReturnValue('true\n')
    expect(isBareRepo('/some/repo.git')).toBe(true)
    expect(gitExecFileSyncMock).toHaveBeenCalledWith(
      ['rev-parse', '--is-bare-repository'],
      { cwd: '/some/repo.git' }
    )
  })

  it('returns false when git rev-parse reports the repo is not bare', () => {
    gitExecFileSyncMock.mockReturnValue('false\n')
    expect(isBareRepo('/some/repo')).toBe(false)
  })

  it('returns false when git rev-parse throws', () => {
    // Why: not-a-git-repo and permission errors both throw. Treating either as
    // "not bare" is the safest default for callers that use this as a gate.
    gitExecFileSyncMock.mockImplementation(() => {
      throw new Error('not a git repository')
    })
    expect(isBareRepo('/not/a/repo')).toBe(false)
  })
})
```

- [ ] **Step 2.3: Run the test to verify failure**

Run:
```bash
pnpm test -- src/main/git/repo.test.ts
```

Expected: the suite fails with `SyntaxError: The requested module './repo' does not provide an export named 'isBareRepo'` (or equivalent). This confirms TDD is working.

- [ ] **Step 2.4: Implement the helper**

Open `src/main/git/repo.ts` and add the helper. Place it after `isGitRepo` (around line 36), before `getRepoName`:

```typescript
/**
 * Check whether the repo at `repoPath` is a bare repository.
 * Sync because it matches the rest of repo.ts and git rev-parse is fast.
 */
export function isBareRepo(repoPath: string): boolean {
  try {
    const result = gitExecFileSync(['rev-parse', '--is-bare-repository'], {
      cwd: repoPath
    }).trim()
    return result === 'true'
  } catch {
    // Why fall through to false on error: non-git directories and permission
    // failures both throw here. Callers use this as a gate for bare-specific
    // behavior, and the safest default when unsure is "not bare" so the
    // caller takes the regular path.
    return false
  }
}
```

- [ ] **Step 2.5: Run the test to verify pass**

Run:
```bash
pnpm test -- src/main/git/repo.test.ts
```

Expected: 3 tests pass.

- [ ] **Step 2.6: Typecheck and full suite**

Run:
```bash
pnpm run tc && pnpm test
```

Expected: all green.

- [ ] **Step 2.7: Commit**

```bash
git add src/main/git/repo.ts src/main/git/repo.test.ts
git commit -m "feat: add isBareRepo() helper in git/repo.ts"
```

---

## Task 3: Create `gitignore.ts` — pure parsing functions

**Files:**
- Create: `src/main/git/gitignore.ts` (new module)
- Create: `src/main/git/gitignore.test.ts` (new test file)

**Why:** Pure, exhaustive unit tests for the parser go first. No IO yet — we add file reads and writes in Task 4.

- [ ] **Step 3.1: Create the test file with failing tests for `isWorktreesDirIgnoredByGitignore`**

Create `src/main/git/gitignore.test.ts`:

```typescript
import { describe, expect, it } from 'vitest'
import { isWorktreesDirIgnoredByGitignore, appendWorktreesEntry } from './gitignore'

describe('isWorktreesDirIgnoredByGitignore', () => {
  it('returns false for null content (no .gitignore file)', () => {
    expect(isWorktreesDirIgnoredByGitignore(null)).toBe(false)
  })

  it('returns false for empty content', () => {
    expect(isWorktreesDirIgnoredByGitignore('')).toBe(false)
  })

  it('recognizes .worktrees/', () => {
    expect(isWorktreesDirIgnoredByGitignore('.worktrees/')).toBe(true)
  })

  it('recognizes .worktrees (no trailing slash)', () => {
    expect(isWorktreesDirIgnoredByGitignore('.worktrees')).toBe(true)
  })

  it('recognizes /.worktrees/', () => {
    expect(isWorktreesDirIgnoredByGitignore('/.worktrees/')).toBe(true)
  })

  it('recognizes /.worktrees', () => {
    expect(isWorktreesDirIgnoredByGitignore('/.worktrees')).toBe(true)
  })

  it('recognizes the entry among unrelated lines', () => {
    const content = ['node_modules/', 'dist/', '.worktrees/', '.env'].join('\n')
    expect(isWorktreesDirIgnoredByGitignore(content)).toBe(true)
  })

  it('ignores comment lines', () => {
    expect(isWorktreesDirIgnoredByGitignore('# .worktrees/')).toBe(false)
  })

  it('ignores negation rules (!.worktrees/)', () => {
    expect(isWorktreesDirIgnoredByGitignore('!.worktrees/')).toBe(false)
  })

  it('does not false-positive on substring matches', () => {
    expect(isWorktreesDirIgnoredByGitignore('.worktrees-cache/')).toBe(false)
    expect(isWorktreesDirIgnoredByGitignore('my.worktrees/')).toBe(false)
  })

  it('handles CRLF line endings', () => {
    expect(isWorktreesDirIgnoredByGitignore('node_modules/\r\n.worktrees/\r\n')).toBe(true)
  })

  it('does NOT match leading-whitespace patterns (\\t.worktrees/)', () => {
    // Regression guard: git treats leading whitespace as part of the pattern,
    // so an indented line is a literal filename, not a rule. Never `.trim()`.
    expect(isWorktreesDirIgnoredByGitignore('\t.worktrees/')).toBe(false)
    expect(isWorktreesDirIgnoredByGitignore('  .worktrees/')).toBe(false)
  })

  it('does NOT match trailing-whitespace patterns (.worktrees/ )', () => {
    // Regression guard: trailing whitespace is significant in gitignore patterns
    // unless escaped. Exact-string matching only.
    expect(isWorktreesDirIgnoredByGitignore('.worktrees/ ')).toBe(false)
  })
})

describe('appendWorktreesEntry', () => {
  it('appends to empty content', () => {
    expect(appendWorktreesEntry('')).toBe('.worktrees/\n')
  })

  it('appends to null content', () => {
    expect(appendWorktreesEntry(null)).toBe('.worktrees/\n')
  })

  it('adds a leading newline when prior content does not end with one', () => {
    expect(appendWorktreesEntry('node_modules/')).toBe('node_modules/\n.worktrees/\n')
  })

  it('does not add a duplicate newline when prior content ends with one', () => {
    expect(appendWorktreesEntry('node_modules/\n')).toBe('node_modules/\n.worktrees/\n')
  })
})
```

- [ ] **Step 3.2: Run the tests to verify failure**

Run:
```bash
pnpm test -- src/main/git/gitignore.test.ts
```

Expected: the whole suite fails with "Cannot find module './gitignore'" (module does not yet exist).

- [ ] **Step 3.3: Create the `gitignore.ts` module with parsing functions**

Create `src/main/git/gitignore.ts`:

```typescript
import { readFile, writeFile } from 'fs/promises'
import { join } from 'path'

const GITIGNORE_NAME = '.gitignore'

// Why these four and only these four: git recognizes many more patterns that
// could effectively ignore `.worktrees/` at the repo root (e.g. `**/.worktrees`,
// globs that happen to match), but implementing the full ignore-rule grammar
// is explicitly a non-goal (see design doc). These four are the canonical
// forms users write by hand; everything else falls through to the prompt.
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

// IO wrappers — implemented in Task 4. Re-exported here so the import in
// gitignore.test.ts stays stable. The test file only imports the pure
// functions, so we don't need the IO wrappers yet, but adding them here
// first would cause Task 4 to be purely additive.
```

- [ ] **Step 3.4: Run the tests to verify pass**

Run:
```bash
pnpm test -- src/main/git/gitignore.test.ts
```

Expected: 17 tests pass (13 parser + 4 append).

- [ ] **Step 3.5: Commit**

```bash
git add src/main/git/gitignore.ts src/main/git/gitignore.test.ts
git commit -m "feat: add gitignore.ts with pure parsing helpers"
```

---

## Task 4: Add gitignore.ts IO wrappers

**Files:**
- Modify: `src/main/git/gitignore.ts` (add async IO functions)
- Modify: `src/main/git/gitignore.test.ts` (add IO tests using a temp directory)

**Why:** Keep this separate from Task 3 so the pure parsing commit stays small and reviewable. The IO tests use a real temp directory via `fs.mkdtemp` because mocking `fs/promises` in every test is overkill.

- [ ] **Step 4.1: Add IO tests to the existing test file**

Append to `src/main/git/gitignore.test.ts`:

```typescript
import { mkdtemp, readFile as fsReadFile, writeFile as fsWriteFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join as pathJoin } from 'path'

import {
  readGitignore,
  isWorktreesDirIgnored,
  addWorktreesDirToGitignore
} from './gitignore'

describe('readGitignore', () => {
  it('returns the file contents when .gitignore exists', async () => {
    const dir = await mkdtemp(pathJoin(tmpdir(), 'orca-gitignore-test-'))
    try {
      await fsWriteFile(pathJoin(dir, '.gitignore'), 'node_modules/\n', 'utf-8')
      expect(await readGitignore(dir)).toBe('node_modules/\n')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('returns null when .gitignore does not exist', async () => {
    const dir = await mkdtemp(pathJoin(tmpdir(), 'orca-gitignore-test-'))
    try {
      expect(await readGitignore(dir)).toBeNull()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('isWorktreesDirIgnored', () => {
  it('returns true when the file contains .worktrees/', async () => {
    const dir = await mkdtemp(pathJoin(tmpdir(), 'orca-gitignore-test-'))
    try {
      await fsWriteFile(pathJoin(dir, '.gitignore'), '.worktrees/\n', 'utf-8')
      expect(await isWorktreesDirIgnored(dir)).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('returns false when the file is missing', async () => {
    const dir = await mkdtemp(pathJoin(tmpdir(), 'orca-gitignore-test-'))
    try {
      expect(await isWorktreesDirIgnored(dir)).toBe(false)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('addWorktreesDirToGitignore', () => {
  it('creates .gitignore with the entry when missing', async () => {
    const dir = await mkdtemp(pathJoin(tmpdir(), 'orca-gitignore-test-'))
    try {
      await addWorktreesDirToGitignore(dir)
      const content = await fsReadFile(pathJoin(dir, '.gitignore'), 'utf-8')
      expect(content).toBe('.worktrees/\n')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('appends the entry to an existing .gitignore', async () => {
    const dir = await mkdtemp(pathJoin(tmpdir(), 'orca-gitignore-test-'))
    try {
      await fsWriteFile(pathJoin(dir, '.gitignore'), 'node_modules/\n', 'utf-8')
      await addWorktreesDirToGitignore(dir)
      const content = await fsReadFile(pathJoin(dir, '.gitignore'), 'utf-8')
      expect(content).toBe('node_modules/\n.worktrees/\n')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('is idempotent — does not duplicate when entry already present', async () => {
    const dir = await mkdtemp(pathJoin(tmpdir(), 'orca-gitignore-test-'))
    try {
      await fsWriteFile(
        pathJoin(dir, '.gitignore'),
        'node_modules/\n.worktrees/\n',
        'utf-8'
      )
      await addWorktreesDirToGitignore(dir)
      const content = await fsReadFile(pathJoin(dir, '.gitignore'), 'utf-8')
      // Unchanged — the entry is already present, so the function is a no-op.
      expect(content).toBe('node_modules/\n.worktrees/\n')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
```

- [ ] **Step 4.2: Run the tests to verify failure**

Run:
```bash
pnpm test -- src/main/git/gitignore.test.ts
```

Expected: the new IO tests fail with "readGitignore is not a function" or equivalent export errors.

- [ ] **Step 4.3: Add IO wrappers to `gitignore.ts`**

Append to `src/main/git/gitignore.ts` (below the existing parsing functions):

```typescript
export async function readGitignore(repoPath: string): Promise<string | null> {
  try {
    return await readFile(join(repoPath, GITIGNORE_NAME), 'utf-8')
  } catch (error) {
    // Why ENOENT = null (not throw): a missing .gitignore is a common state,
    // not an error. Callers use this to branch on "does the file exist at
    // all". Any other error (EACCES, EIO) still throws so we don't silently
    // hide real problems.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

export async function isWorktreesDirIgnored(repoPath: string): Promise<boolean> {
  return isWorktreesDirIgnoredByGitignore(await readGitignore(repoPath))
}

export async function addWorktreesDirToGitignore(repoPath: string): Promise<void> {
  const content = await readGitignore(repoPath)
  // Why idempotent re-check: a racing second click or rapid second create
  // must not duplicate the entry. Trusting the renderer to only call this
  // when needed would be fragile — re-checking costs one file read and makes
  // the function safe to call repeatedly.
  if (isWorktreesDirIgnoredByGitignore(content)) return
  await writeFile(join(repoPath, GITIGNORE_NAME), appendWorktreesEntry(content), 'utf-8')
}
```

- [ ] **Step 4.4: Run the tests to verify pass**

Run:
```bash
pnpm test -- src/main/git/gitignore.test.ts
```

Expected: all tests pass (17 from Task 3 + 7 new IO tests = 24).

- [ ] **Step 4.5: Typecheck and full suite**

Run:
```bash
pnpm run tc && pnpm test
```

Expected: all green.

- [ ] **Step 4.6: Commit**

```bash
git add src/main/git/gitignore.ts src/main/git/gitignore.test.ts
git commit -m "feat: add gitignore.ts IO wrappers (read, check, add entry)"
```

---

## Task 5: Refactor `computeWorktreePath` — add in-repo branch + fold validation

**Files:**
- Modify: `src/main/ipc/worktree-logic.ts`
- Modify: `src/main/ipc/worktree-logic.test.ts`
- Modify: `src/main/ipc/worktree-logic-wsl.test.ts` (update existing test fixtures)

**Why:** This is the core refactor. It adds the in-repo branch, internalizes path-traversal validation for all three modes, and handles UNC paths correctly on Linux CI. Existing tests must still pass; new tests lock in the new behavior.

**Critical:** The spec notes the WSL branch now calls `ensureWithinRoot` internally — this is **net-new validation behavior** on the WSL path. Pay attention to Step 5.3 (new regression test) and Step 5.7 (existing tests may need updating).

- [ ] **Step 5.1: Write the failing tests for in-repo mode**

Open `src/main/ipc/worktree-logic.test.ts`. Add a new `describe` block after the existing `describe('computeWorktreePath', ...)` block:

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

  it('throws on path traversal attempts in in-repo mode', () => {
    // sanitizeWorktreeName already strips traversal, but defense-in-depth.
    expect(() =>
      computeWorktreePath('../escape', '/repos/my-project', {
        nestWorkspaces: true,
        workspaceDir: '/workspaces',
        worktreeLocation: 'in-repo'
      })
    ).toThrow('Invalid worktree path')
  })
})
```

Also update the existing `describe('computeWorktreePath', ...)` test cases to include the new field. The existing tests use 2-field settings objects (`nestWorkspaces`, `workspaceDir`) and will fail to typecheck after the refactor. For each existing `computeWorktreePath` call in this file, add `worktreeLocation: 'external'`:

```typescript
// Example transformation:
computeWorktreePath('feature', '/repos/my-project', {
  nestWorkspaces: true,
  workspaceDir: '/workspaces',
  worktreeLocation: 'external'   // ← add this line to every existing test case
})
```

Add a regression guard for external mode at the end of the existing block (before the new in-repo describe):

```typescript
it('still nests under repo name when worktreeLocation is external (regression)', () => {
  // Lock in that adding the new field does not perturb the default flow.
  expect(
    computeWorktreePath('feature', '/repos/my-project', {
      nestWorkspaces: true,
      workspaceDir: '/workspaces',
      worktreeLocation: 'external'
    })
  ).toBe(join('/workspaces', 'my-project', 'feature'))
})
```

- [ ] **Step 5.2: Update the WSL test fixtures for the new field**

Open `src/main/ipc/worktree-logic-wsl.test.ts`. Every `computeWorktreePath` call in this file needs `worktreeLocation: 'external'` added to the settings object. Transform both test cases:

```typescript
// First test (line 29-34):
expect(
  computeWorktreePath('feature', '\\\\wsl.localhost\\Ubuntu\\home\\jin\\src\\repo', {
    nestWorkspaces: true,
    workspaceDir: 'C:\\workspaces',
    worktreeLocation: 'external'
  })
).toBe('\\\\wsl.localhost\\Ubuntu\\home\\jin\\orca\\workspaces\\repo\\feature')

// Second test (line 44-49):
expect(
  computeWorktreePath('feature', '\\\\wsl.localhost\\Ubuntu\\home\\jin\\src\\repo', {
    nestWorkspaces: false,
    workspaceDir: 'C:\\workspaces',
    worktreeLocation: 'external'
  })
).toBe(win32.join('C:\\workspaces', 'feature'))
```

- [ ] **Step 5.3: Add a WSL + in-repo mode regression test**

Append to `src/main/ipc/worktree-logic-wsl.test.ts` (inside the existing `describe` block):

```typescript
it('in-repo mode places WSL repo worktrees under the repo directory, skipping the WSL workspace override', () => {
  // The mocks below are intentionally NOT called by computeWorktreePath when
  // worktreeLocation is 'in-repo' — the in-repo branch runs first and uses
  // win32 path operations directly on the repo path. We assert this by
  // verifying both mocks have zero calls at the end of the test. Setting
  // the return values is defensive: if a future refactor accidentally
  // routes the in-repo branch through parseWslPath/getWslHome, the mocks
  // will return plausible values instead of returning undefined.
  parseWslPathMock.mockReturnValue({
    distro: 'Ubuntu',
    linuxPath: '/home/jin/src/repo'
  })
  getWslHomeMock.mockReturnValue('\\\\wsl.localhost\\Ubuntu\\home\\jin')

  expect(
    computeWorktreePath('feature', '\\\\wsl.localhost\\Ubuntu\\home\\jin\\src\\repo', {
      nestWorkspaces: true,
      workspaceDir: 'C:\\workspaces',
      worktreeLocation: 'in-repo'
    })
  ).toBe('\\\\wsl.localhost\\Ubuntu\\home\\jin\\src\\repo\\.worktrees\\feature')

  // Lock in that the in-repo branch never touched the WSL helpers.
  expect(parseWslPathMock).not.toHaveBeenCalled()
  expect(getWslHomeMock).not.toHaveBeenCalled()
})
```

- [ ] **Step 5.4: Run the tests to verify failure**

Run:
```bash
pnpm test -- src/main/ipc/worktree-logic.test.ts src/main/ipc/worktree-logic-wsl.test.ts
```

Expected: the new in-repo tests fail (`worktreeLocation` is an unknown property on the settings shape, or `'in-repo'` mode falls through to external logic and produces the wrong path). The existing tests that you updated in Step 5.1/5.2 may either pass or fail depending on type checks.

- [ ] **Step 5.5: Refactor `computeWorktreePath` with the internal helper**

Open `src/main/ipc/worktree-logic.ts`. At the top, update the import to include `posix` (it's already there) and add a type import:

```typescript
import { basename, join, resolve, relative, isAbsolute, posix, win32 } from 'path'
import type { GitWorktreeInfo, Worktree, WorktreeMeta, WorktreeLocation } from '../../shared/types'
import { getWslHome, parseWslPath } from '../wsl'
```

Then replace the existing `ensurePathWithinWorkspace` export with a private helper + a backward-compat shim. Keep the old name exported for the test file, but add the new signature internally:

```typescript
// Internal helper: same logic as the old ensurePathWithinWorkspace, but
// takes explicit path operations so UNC paths can be validated correctly
// on Linux CI (where platform-default posix.resolve mangles backslashes).
type PathOps = Pick<typeof win32, 'basename' | 'join' | 'resolve' | 'relative' | 'isAbsolute'>

function ensureWithinRoot(targetPath: string, root: string, ops: PathOps): string {
  const resolvedRoot = ops.resolve(root)
  const resolvedTarget = ops.resolve(targetPath)
  const rel = ops.relative(resolvedRoot, resolvedTarget)
  if (ops.isAbsolute(rel) || rel.startsWith('..')) {
    throw new Error('Invalid worktree path')
  }
  return resolvedTarget
}

function pickPathOps(...paths: string[]): PathOps {
  // Any Windows-looking path forces win32 so UNC paths validate correctly
  // on Linux CI. Otherwise we use platform default (posix on Linux/Mac,
  // win32 on Windows). This matches the existing `pathOps` trick used
  // elsewhere in this file.
  if (paths.some(looksLikeWindowsPath)) {
    return win32
  }
  return { basename, join, resolve, relative, isAbsolute }
}

/**
 * Ensure a target path is within the workspace directory (prevent path traversal).
 * Kept exported for backward compatibility with callers that still use this name;
 * prefer the internal `ensureWithinRoot` for new code.
 */
export function ensurePathWithinWorkspace(targetPath: string, workspaceDir: string): string {
  return ensureWithinRoot(targetPath, workspaceDir, pickPathOps(targetPath, workspaceDir))
}
```

Now rewrite `computeWorktreePath` to include the in-repo branch and fold validation into all three branches:

```typescript
export function computeWorktreePath(
  sanitizedName: string,
  repoPath: string,
  settings: {
    nestWorkspaces: boolean
    workspaceDir: string
    worktreeLocation: WorktreeLocation
  }
): string {
  // In-repo mode runs first. Why: it bypasses both the WSL special case
  // (worktrees inherit the repo's filesystem automatically because they
  // live inside it) and the user-configured workspaceDir (which is
  // irrelevant when worktrees live inside the repo). Skipping straight
  // to this branch means the WSL override never fires for in-repo mode.
  if (settings.worktreeLocation === 'in-repo') {
    const ops = pickPathOps(repoPath)
    const worktreesRoot = ops.join(repoPath, '.worktrees')
    const candidate = ops.join(worktreesRoot, sanitizedName)
    return ensureWithinRoot(candidate, worktreesRoot, ops)
  }

  const wsl = parseWslPath(repoPath)
  if (wsl) {
    const wslHome = getWslHome(wsl.distro)
    if (wslHome) {
      // Why WSL special case: when the repo lives on a WSL filesystem,
      // worktrees must also live on the WSL filesystem. Creating them on
      // the Windows side (/mnt/c/...) would be extremely slow due to
      // cross-filesystem I/O and the terminal would open a Windows shell
      // instead of WSL. We mirror the Windows workspace layout inside
      // ~/orca/workspaces on the WSL filesystem. All path operations here
      // use win32 because WSL UNC paths are still Windows paths from
      // Node's perspective.
      const wslWorkspaceDir = win32.join(wslHome, 'orca', 'workspaces')
      const candidate = settings.nestWorkspaces
        ? win32.join(
            wslWorkspaceDir,
            win32.basename(repoPath).replace(/\.git$/, ''),
            sanitizedName
          )
        : win32.join(wslWorkspaceDir, sanitizedName)
      return ensureWithinRoot(candidate, wslWorkspaceDir, win32)
    }
  }

  const ops = pickPathOps(repoPath, settings.workspaceDir)
  const candidate = settings.nestWorkspaces
    ? ops.join(
        settings.workspaceDir,
        ops.basename(repoPath).replace(/\.git$/, ''),
        sanitizedName
      )
    : ops.join(settings.workspaceDir, sanitizedName)
  return ensureWithinRoot(candidate, settings.workspaceDir, ops)
}
```

- [ ] **Step 5.6: Run the targeted tests to verify pass**

Run:
```bash
pnpm test -- src/main/ipc/worktree-logic.test.ts src/main/ipc/worktree-logic-wsl.test.ts
```

Expected: all tests pass, including the new in-repo cases and the WSL regression test.

- [ ] **Step 5.7: Run the full test suite**

Run:
```bash
pnpm test
```

Expected: all green. If any existing test fails because of the `GlobalSettings` shape change, add `worktreeLocation: 'external'` to the failing fixture. Common places to look:
- `src/main/ipc/worktrees.test.ts` — settings fixtures passed to the IPC handler
- `src/main/ipc/worktrees-windows.test.ts` — same
- `src/main/ipc/filesystem.test.ts` — if it uses a settings fixture
- Any other test that constructs a `GlobalSettings`-shaped object

- [ ] **Step 5.8: Typecheck**

Run:
```bash
pnpm run tc
```

Expected: all three projects compile clean.

- [ ] **Step 5.9: Commit**

```bash
git add src/main/ipc/worktree-logic.ts src/main/ipc/worktree-logic.test.ts src/main/ipc/worktree-logic-wsl.test.ts
# Also add any test fixtures you updated in Step 5.7
git commit -m "refactor: add in-repo branch to computeWorktreePath with internal validation"
```

---

## Task 6: Collapse the calling code in `worktrees.ts`

**Files:**
- Modify: `src/main/ipc/worktrees.ts` (delete lines 134-142)

**Critical:** The spec flags this as the single step most likely to cause a broken feature if done wrong. Delete ALL of the old WSL root + validation code, not just some of it.

- [ ] **Step 6.1: Delete the old WSL root computation and standalone validation call**

Open `src/main/ipc/worktrees.ts`. Find the block around line 134-142 that looks like:

```typescript
// Compute worktree path
let worktreePath = computeWorktreePath(sanitizedName, repo.path, settings)
// Why: WSL worktrees live under ~/orca/workspaces inside the WSL
// filesystem. Validate against that root, not the Windows workspace dir.
// If WSL home lookup fails, keep using the configured workspace root so
// the path traversal guard still runs on the fallback path.
const wslInfo = isWslPath(repo.path) ? parseWslPath(repo.path) : null
const wslHome = wslInfo ? getWslHome(wslInfo.distro) : null
const workspaceRoot = wslHome ? join(wslHome, 'orca', 'workspaces') : settings.workspaceDir
worktreePath = ensurePathWithinWorkspace(worktreePath, workspaceRoot)
```

Replace the entire block with a single line:

```typescript
// Compute worktree path. computeWorktreePath now handles WSL, in-repo,
// and external modes internally, and runs path-traversal validation
// against the correct root for each mode.
const worktreePath = computeWorktreePath(sanitizedName, repo.path, settings)
```

Also note: `worktreePath` is no longer `let`, it's `const`. Previously it was reassigned after the `ensurePathWithinWorkspace` call; now the single-line form makes it const.

- [ ] **Step 6.2: Remove now-unused imports from the top of the file**

At the top of `src/main/ipc/worktrees.ts`, remove these imports if they have no other uses in the file:
- `import { join } from 'path'` — was only used by the deleted block
- `import { isWslPath, parseWslPath, getWslHome } from '../wsl'` — was only used by the deleted block
- `import { ensurePathWithinWorkspace } from './worktree-logic'` — also only used by the deleted block (but `worktree-logic` has other imports, only remove `ensurePathWithinWorkspace` from the destructure)

Verify each import has no remaining use before deleting:

```bash
# From the repo root:
grep -n "\bjoin\b" src/main/ipc/worktrees.ts
grep -n "\b\(isWslPath\|parseWslPath\|getWslHome\)\b" src/main/ipc/worktrees.ts
grep -n "\bensurePathWithinWorkspace\b" src/main/ipc/worktrees.ts
```

If any of those greps return non-import lines, keep the corresponding import. Otherwise delete.

- [ ] **Step 6.3: Clean up the mocks in `worktrees.test.ts` and `worktrees-windows.test.ts`**

Both test files still mock `ensurePathWithinWorkspace` via `vi.hoisted`. The production code no longer calls it, so the mock is dead. Remove the dead mock entries carefully — leaving a `mockImplementation` / `mockReturnValue` call referencing a deleted variable causes a runtime error (`ensurePathWithinWorkspaceMock is not defined`).

**In `src/main/ipc/worktrees.test.ts`, remove ALL of these:**

1. The `ensurePathWithinWorkspaceMock` entry from the `vi.hoisted` destructure at the top of the file (around line 21).
2. The `ensurePathWithinWorkspaceMock: vi.fn()` entry in the `vi.hoisted` return object (around line 39).
3. The `ensurePathWithinWorkspace: ensurePathWithinWorkspaceMock` entry in the `vi.mock('./worktree-logic', ...)` block (around line 79).
4. Any destructured list in the body that references `ensurePathWithinWorkspaceMock,` (around line 122).
5. **`ensurePathWithinWorkspaceMock.mockImplementation((targetPath: string) => targetPath)` in the `beforeEach` block (around line 188).** ← This is the one that will throw at runtime if left behind.

**In `src/main/ipc/worktrees-windows.test.ts`, remove ALL of these:**

1. The `ensurePathWithinWorkspaceMock` entry from the `vi.hoisted` destructure (around line 20).
2. The `ensurePathWithinWorkspaceMock: vi.fn()` in the hoisted return (around line 38).
3. The `ensurePathWithinWorkspace: ensurePathWithinWorkspaceMock` in the `vi.mock('./worktree-logic', ...)` block (around line 78).
4. **`ensurePathWithinWorkspaceMock.mockReset()` in the `beforeEach` block (around line 120).**
5. **`ensurePathWithinWorkspaceMock.mockReturnValue('C:\\workspaces\\improve-dashboard')` in a test body (around line 168).**

After the cleanup, grep each file to confirm no references remain:

```bash
grep -n "ensurePathWithinWorkspaceMock" src/main/ipc/worktrees.test.ts
grep -n "ensurePathWithinWorkspaceMock" src/main/ipc/worktrees-windows.test.ts
```

Expected: both commands return zero hits.

- [ ] **Step 6.4: Run the IPC tests**

Run:
```bash
pnpm test -- src/main/ipc/worktrees.test.ts src/main/ipc/worktrees-windows.test.ts
```

Expected: all green. If anything fails, the cleanup missed a reference.

- [ ] **Step 6.5: Run the full suite**

Run:
```bash
pnpm test && pnpm run tc
```

Expected: all green.

- [ ] **Step 6.6: Commit**

```bash
git add src/main/ipc/worktrees.ts src/main/ipc/worktrees.test.ts src/main/ipc/worktrees-windows.test.ts
git commit -m "refactor: collapse WSL root selection in worktrees.ts into computeWorktreePath"
```

---

## Task 7: Register `gitignore:checkWorktreesIgnored` IPC handler

**Files:**
- Modify: `src/main/ipc/worktrees.ts` (add handler registration)
- Modify: `src/main/ipc/worktrees.test.ts` (add handler tests)

- [ ] **Step 7.1: Write the failing handler test**

Open `src/main/ipc/worktrees.test.ts`. The file already has the handler-registration pattern — every IPC handler is tested by calling `handleMock.mock.calls.find(...)` to retrieve the handler and invoking it. Add these new tests at an appropriate place in the file (next to the existing `worktrees:create` tests):

```typescript
describe('gitignore:checkWorktreesIgnored handler', () => {
  const getHandler = (): ((event: unknown, args: unknown) => Promise<unknown>) => {
    const entry = handleMock.mock.calls.find((call) => call[0] === 'gitignore:checkWorktreesIgnored')
    if (!entry) throw new Error('gitignore:checkWorktreesIgnored not registered')
    return entry[1] as (event: unknown, args: unknown) => Promise<unknown>
  }

  it('returns ignored: true for a repo whose .gitignore contains .worktrees/', async () => {
    // Setup: a git repo with `.worktrees/` in .gitignore
    const dir = await mkdtemp(pathJoin(tmpdir(), 'orca-gi-handler-'))
    await fsWriteFile(pathJoin(dir, '.gitignore'), '.worktrees/\n', 'utf-8')
    try {
      store.getRepo.mockReturnValue({ id: 'r1', path: dir, kind: 'git' })
      // isBareRepo is called on the real path; it will return false because
      // we did not initialize a bare repo. That's the happy path — the
      // handler then reads .gitignore.
      const handler = getHandler()
      const result = await handler({}, { repoId: 'r1' })
      expect(result).toEqual({ ignored: true })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('returns ignored: false when .gitignore is missing', async () => {
    const dir = await mkdtemp(pathJoin(tmpdir(), 'orca-gi-handler-'))
    try {
      store.getRepo.mockReturnValue({ id: 'r1', path: dir, kind: 'git' })
      const handler = getHandler()
      const result = await handler({}, { repoId: 'r1' })
      expect(result).toEqual({ ignored: false })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('returns ignored: true for folder repos (short-circuit)', async () => {
    store.getRepo.mockReturnValue({ id: 'r1', path: '/fake', kind: 'folder' })
    const handler = getHandler()
    const result = await handler({}, { repoId: 'r1' })
    expect(result).toEqual({ ignored: true })
  })

  it('returns ignored: true when the repo is not found (guard)', async () => {
    store.getRepo.mockReturnValue(undefined)
    const handler = getHandler()
    const result = await handler({}, { repoId: 'missing' })
    expect(result).toEqual({ ignored: true })
  })
})
```

The test file needs imports for `mkdtemp`, `fsWriteFile`, `rm`, `tmpdir`, `pathJoin` if not already present. Add at the top of the file:

```typescript
import { mkdtemp, writeFile as fsWriteFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join as pathJoin } from 'path'
```

You also need to mock `isBareRepo` from `../git/repo`. Make three concrete edits to the existing test file:

**Edit 1:** Add `isBareRepoMock` to the `vi.hoisted` destructure at the top of the file:

```typescript
const {
  handleMock,
  removeHandlerMock,
  listWorktreesMock,
  addWorktreeMock,
  removeWorktreeMock,
  getGitUsernameMock,
  getDefaultBaseRefMock,
  getBranchConflictKindMock,
  isBareRepoMock,                   // ← add
  // ... rest unchanged
} = vi.hoisted(() => ({
  handleMock: vi.fn(),
  removeHandlerMock: vi.fn(),
  listWorktreesMock: vi.fn(),
  addWorktreeMock: vi.fn(),
  removeWorktreeMock: vi.fn(),
  getGitUsernameMock: vi.fn(),
  getDefaultBaseRefMock: vi.fn(),
  getBranchConflictKindMock: vi.fn(),
  isBareRepoMock: vi.fn(),          // ← add
  // ... rest unchanged
}))
```

**Edit 2:** Add `isBareRepo: isBareRepoMock` to the existing `vi.mock('../git/repo', ...)` block:

```typescript
vi.mock('../git/repo', () => ({
  getGitUsername: getGitUsernameMock,
  getDefaultBaseRef: getDefaultBaseRefMock,
  getBranchConflictKind: getBranchConflictKindMock,
  isBareRepo: isBareRepoMock          // ← add
}))
```

**Edit 3:** Default the mock to `false` in `beforeEach` so all existing tests take the "not bare" path:

```typescript
beforeEach(() => {
  // ... existing resets ...
  isBareRepoMock.mockReset()
  isBareRepoMock.mockReturnValue(false)
})
```

The mock defaulting to `false` means real-directory tests (Steps 7.1 and 8.1) take the "not bare" path and exercise the real `isWorktreesDirIgnored`.

- [ ] **Step 7.2: Run the tests to verify failure**

Run:
```bash
pnpm test -- src/main/ipc/worktrees.test.ts
```

Expected: the new test block fails with "gitignore:checkWorktreesIgnored not registered" — the handler isn't wired yet.

- [ ] **Step 7.3: Register the handler in `worktrees.ts`**

Open `src/main/ipc/worktrees.ts`. Add imports for the gitignore helpers and the bare-repo helper:

```typescript
import { isWorktreesDirIgnored, addWorktreesDirToGitignore } from '../git/gitignore'
import { getGitUsername, getDefaultBaseRef, getBranchConflictKind, isBareRepo } from '../git/repo'
```

At the top of `registerWorktreeHandlers`, add `gitignore:*` to the `removeHandler` cleanup list (mirroring the existing pattern for `worktrees:*`):

```typescript
ipcMain.removeHandler('worktrees:listAll')
ipcMain.removeHandler('worktrees:list')
ipcMain.removeHandler('worktrees:create')
ipcMain.removeHandler('worktrees:remove')
ipcMain.removeHandler('worktrees:updateMeta')
ipcMain.removeHandler('worktrees:persistSortOrder')
ipcMain.removeHandler('hooks:check')
ipcMain.removeHandler('gitignore:checkWorktreesIgnored')
ipcMain.removeHandler('gitignore:addWorktreesEntry')
```

Then add the new handler. Place it alongside the existing `hooks:check` handler at the bottom of `registerWorktreeHandlers`:

```typescript
ipcMain.handle('gitignore:checkWorktreesIgnored', async (_event, args: { repoId: string }) => {
  const repo = store.getRepo(args.repoId)
  // Folder repos can't have worktrees, and bare repos have no working tree
  // to dirty. In both cases, treat as already-handled to short-circuit any
  // UI gating in the renderer. Missing repo also returns ignored: true so
  // the UI can't leak error detail via this handler.
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
```

- [ ] **Step 7.4: Run the tests to verify pass**

Run:
```bash
pnpm test -- src/main/ipc/worktrees.test.ts
```

Expected: the new test block passes (4 new tests). Previous tests still green.

- [ ] **Step 7.5: Commit**

```bash
git add src/main/ipc/worktrees.ts src/main/ipc/worktrees.test.ts
git commit -m "feat: add gitignore:checkWorktreesIgnored IPC handler"
```

---

## Task 8: Register `gitignore:addWorktreesEntry` IPC handler

**Files:**
- Modify: `src/main/ipc/worktrees.ts`
- Modify: `src/main/ipc/worktrees.test.ts`

- [ ] **Step 8.1: Write the failing handler test**

Append to `src/main/ipc/worktrees.test.ts`:

```typescript
describe('gitignore:addWorktreesEntry handler', () => {
  const getHandler = (): ((event: unknown, args: unknown) => Promise<void>) => {
    const entry = handleMock.mock.calls.find((call) => call[0] === 'gitignore:addWorktreesEntry')
    if (!entry) throw new Error('gitignore:addWorktreesEntry not registered')
    return entry[1] as (event: unknown, args: unknown) => Promise<void>
  }

  it('creates .gitignore with the entry when it did not exist', async () => {
    const dir = await mkdtemp(pathJoin(tmpdir(), 'orca-gi-add-'))
    try {
      store.getRepo.mockReturnValue({ id: 'r1', path: dir, kind: 'git' })
      const handler = getHandler()
      await handler({}, { repoId: 'r1' })
      const content = await readFile(pathJoin(dir, '.gitignore'), 'utf-8')
      expect(content).toBe('.worktrees/\n')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('appends to an existing .gitignore', async () => {
    const dir = await mkdtemp(pathJoin(tmpdir(), 'orca-gi-add-'))
    try {
      await fsWriteFile(pathJoin(dir, '.gitignore'), 'node_modules/\n', 'utf-8')
      store.getRepo.mockReturnValue({ id: 'r1', path: dir, kind: 'git' })
      const handler = getHandler()
      await handler({}, { repoId: 'r1' })
      const content = await readFile(pathJoin(dir, '.gitignore'), 'utf-8')
      expect(content).toBe('node_modules/\n.worktrees/\n')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('throws for folder repos', async () => {
    store.getRepo.mockReturnValue({ id: 'r1', path: '/fake', kind: 'folder' })
    const handler = getHandler()
    await expect(handler({}, { repoId: 'r1' })).rejects.toThrow(
      'Cannot modify .gitignore for this repo type.'
    )
  })
})
```

Add `readFile` to the imports at the top (if not already present):

```typescript
import { mkdtemp, writeFile as fsWriteFile, rm, readFile } from 'fs/promises'
```

- [ ] **Step 8.2: Run the tests to verify failure**

Run:
```bash
pnpm test -- src/main/ipc/worktrees.test.ts
```

Expected: the new block fails with "gitignore:addWorktreesEntry not registered".

- [ ] **Step 8.3: Register the handler in `worktrees.ts`**

Directly below the `gitignore:checkWorktreesIgnored` handler you added in Task 7, register the second handler:

```typescript
ipcMain.handle('gitignore:addWorktreesEntry', async (_event, args: { repoId: string }) => {
  const repo = store.getRepo(args.repoId)
  if (!repo || isFolderRepo(repo)) {
    throw new Error('Cannot modify .gitignore for this repo type.')
  }
  await addWorktreesDirToGitignore(repo.path)
})
```

- [ ] **Step 8.4: Run the tests to verify pass**

Run:
```bash
pnpm test -- src/main/ipc/worktrees.test.ts
```

Expected: 3 new tests pass. Previous tests still green.

- [ ] **Step 8.5: Full suite and typecheck**

Run:
```bash
pnpm test && pnpm run tc
```

Expected: all green.

- [ ] **Step 8.6: Commit**

```bash
git add src/main/ipc/worktrees.ts src/main/ipc/worktrees.test.ts
git commit -m "feat: add gitignore:addWorktreesEntry IPC handler"
```

---

## Task 9: Expose the preload bridge for the gitignore IPCs

**Files:**
- Modify: `src/preload/index.ts` (add `gitignore` namespace)
- Modify: `src/preload/index.d.ts` (add `GitignoreApi` type and `gitignore` field on `Api`)

**Why:** The renderer can't call the new IPCs until the preload bridge exposes them. No tests — the typecheck is the gate.

- [ ] **Step 9.1: Add the namespace in `src/preload/index.ts`**

Open `src/preload/index.ts` and locate the `hooks:` block at line 307. Add a new `gitignore:` block directly after it:

```typescript
hooks: {
  check: (args: { repoId: string }): Promise<{ hasHooks: boolean; hooks: unknown }> =>
    ipcRenderer.invoke('hooks:check', args)
},

gitignore: {
  checkWorktreesIgnored: (args: { repoId: string }): Promise<{ ignored: boolean }> =>
    ipcRenderer.invoke('gitignore:checkWorktreesIgnored', args),
  addWorktreesEntry: (args: { repoId: string }): Promise<void> =>
    ipcRenderer.invoke('gitignore:addWorktreesEntry', args)
},
```

- [ ] **Step 9.2: Add the type declaration in `src/preload/index.d.ts`**

Open `src/preload/index.d.ts` and locate the `HooksApi` type at line 136. Add the new type directly after it:

```typescript
type HooksApi = {
  check: (args: { repoId: string }) => Promise<{ hasHooks: boolean; hooks: OrcaHooks | null }>
}

type GitignoreApi = {
  checkWorktreesIgnored: (args: { repoId: string }) => Promise<{ ignored: boolean }>
  addWorktreesEntry: (args: { repoId: string }) => Promise<void>
}
```

Then add `gitignore: GitignoreApi` to the main `Api` type around line 264, next to the existing `hooks: HooksApi` line:

```typescript
  notifications: NotificationsApi
  shell: ShellApi
  hooks: HooksApi
  gitignore: GitignoreApi
  cache: CacheApi
  session: SessionApi
```

**Do not skip this second step.** Without adding `gitignore: GitignoreApi` to the `Api` type, the renderer's TypeScript will not see `window.api.gitignore.*` and every call will be `any`-typed.

- [ ] **Step 9.3: Typecheck**

Run:
```bash
pnpm run tc
```

Expected: all three projects compile clean.

- [ ] **Step 9.4: Full test suite (sanity)**

Run:
```bash
pnpm test
```

Expected: all green — this task should be invisible to tests.

- [ ] **Step 9.5: Commit**

```bash
git add src/preload/index.ts src/preload/index.d.ts
git commit -m "feat: expose gitignore IPC namespace via preload bridge"
```

---

## Task 10: Refactor `AddWorktreeDialog.handleCreate` into `handleCreate` + `performCreate`

**Files:**
- Modify: `src/renderer/src/components/sidebar/AddWorktreeDialog.tsx`

**Why:** Prepare the structure for the gitignore gate (Task 11) by splitting decide-what-to-do from do-it. No behavior change — the refactor must be invisible to users.

**Note on verification:** `AddWorktreeDialog.tsx` has no unit tests today (verified: no file matching `AddWorktreeDialog.test.*` exists). That means **tasks 10-14 rely on typecheck + lint for static verification and on the manual smoke test in Task 18 for behavioral verification**. Do not skip Task 18 — it is the only place where the actual create flow (including the new confirmation pane) is exercised end-to-end.

- [ ] **Step 10.1: Extract `performCreate` from the existing `handleCreate` body**

Open `src/renderer/src/components/sidebar/AddWorktreeDialog.tsx`. The current `handleCreate` (lines 146-228) does two things: gates on validity and does the create. Split it like this.

Replace the entire `handleCreate` definition with:

```typescript
const performCreate = useCallback(async () => {
  setCreateError(null)
  setCreating(true)
  try {
    const result = await createWorktree(
      repoId,
      name.trim(),
      undefined,
      setupConfig ? ((resolvedSetupDecision ?? 'inherit') as SetupDecision) : 'inherit'
    )
    const wt = result.worktree
    // Meta update is best-effort — the worktree already exists, so don't
    // block the success path if only the metadata write fails.
    try {
      const metaUpdates: Record<string, unknown> = {}
      if (linkedIssue.trim()) {
        const linkedIssueNumber = parseGitHubIssueOrPRNumber(linkedIssue)
        if (linkedIssueNumber !== null) {
          ;(metaUpdates as { linkedIssue: number }).linkedIssue = linkedIssueNumber
        }
      }
      if (comment.trim()) {
        ;(metaUpdates as { comment: string }).comment = comment.trim()
      }
      if (Object.keys(metaUpdates).length > 0) {
        await updateWorktreeMeta(wt.id, metaUpdates as { linkedIssue?: number; comment?: string })
      }
    } catch {
      console.error('Failed to update worktree meta after creation')
    }

    setActiveRepo(repoId)
    setActiveView('terminal')
    setSidebarOpen(true)
    if (searchQuery) {
      setSearchQuery('')
    }
    if (filterRepoIds.length > 0 && !filterRepoIds.includes(repoId)) {
      setFilterRepoIds([])
    }
    setActiveWorktree(wt.id)
    ensureWorktreeHasInitialTerminal(useAppStore.getState(), wt.id, result.setup)
    revealWorktreeInSidebar(wt.id)
    if (settings?.rightSidebarOpenByDefault) {
      setRightSidebarTab('explorer')
      setRightSidebarOpen(true)
    }
    handleOpenChange(false)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to create worktree.'
    setCreateError(message)
    toast.error(message)
  } finally {
    setCreating(false)
  }
}, [
  repoId,
  name,
  linkedIssue,
  comment,
  createWorktree,
  updateWorktreeMeta,
  setActiveRepo,
  setActiveView,
  setSidebarOpen,
  searchQuery,
  setSearchQuery,
  filterRepoIds,
  setFilterRepoIds,
  setActiveWorktree,
  revealWorktreeInSidebar,
  setRightSidebarOpen,
  setRightSidebarTab,
  settings?.rightSidebarOpenByDefault,
  handleOpenChange,
  resolvedSetupDecision,
  setupConfig
])

const handleCreate = useCallback(async () => {
  if (!repoId || !name.trim() || shouldWaitForSetupCheck || !selectedRepo) {
    return
  }
  await performCreate()
}, [repoId, name, shouldWaitForSetupCheck, selectedRepo, performCreate])
```

Notice:
- All the body of the old `handleCreate` moves verbatim into `performCreate`, minus the initial guard.
- `handleCreate` becomes a thin gate that calls `performCreate` when the guard passes.
- `performCreate` inherits the existing long dep list.
- `handleCreate` has a much shorter dep list because most work moved.

- [ ] **Step 10.2: Typecheck**

Run:
```bash
pnpm run tc
```

Expected: all three projects compile clean. Dependency-array lint errors (from `react-hooks/exhaustive-deps`) would also show up here.

- [ ] **Step 10.3: Lint**

Run:
```bash
pnpm run lint
```

Expected: clean (or at least no new issues compared to baseline). The extracted `performCreate` should have the full dep list and not trigger `exhaustive-deps`.

- [ ] **Step 10.4: Commit**

```bash
git add src/renderer/src/components/sidebar/AddWorktreeDialog.tsx
git commit -m "refactor: split AddWorktreeDialog handleCreate into handleCreate + performCreate"
```

---

## Task 11: Add the gitignore gate in `handleCreate`

**Files:**
- Modify: `src/renderer/src/components/sidebar/AddWorktreeDialog.tsx`

**Why:** Now that `handleCreate` is a thin gate, add the pre-check against `window.api.gitignore.checkWorktreesIgnored` when `worktreeLocation === 'in-repo'`. No UI yet; the confirmation pane comes in Task 12.

- [ ] **Step 11.1: Add the `pendingGitignoreConfirm` state**

Near the top of `AddWorktreeDialog`, alongside the other `useState` calls, add:

```typescript
const [pendingGitignoreConfirm, setPendingGitignoreConfirm] = useState(false)
```

Place it next to `const [creating, setCreating] = useState(false)` for readability.

- [ ] **Step 11.2: Update `performCreate` to take `addGitignoreEntry` and reset the confirm state**

Replace the `performCreate` definition from Task 10 in its entirety with this new version. The differences from Task 10 are:
1. New `{ addGitignoreEntry }` parameter destructure.
2. New `if (addGitignoreEntry)` block at the top of the `try` that calls the gitignore IPC.
3. New `setPendingGitignoreConfirm(false)` line in the `finally` block.

Everything else (create call, meta update, navigation, error handling) is unchanged from Task 10.

```typescript
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

      const result = await createWorktree(
        repoId,
        name.trim(),
        undefined,
        setupConfig ? ((resolvedSetupDecision ?? 'inherit') as SetupDecision) : 'inherit'
      )
      const wt = result.worktree
      // Meta update is best-effort — the worktree already exists, so don't
      // block the success path if only the metadata write fails.
      try {
        const metaUpdates: Record<string, unknown> = {}
        if (linkedIssue.trim()) {
          const linkedIssueNumber = parseGitHubIssueOrPRNumber(linkedIssue)
          if (linkedIssueNumber !== null) {
            ;(metaUpdates as { linkedIssue: number }).linkedIssue = linkedIssueNumber
          }
        }
        if (comment.trim()) {
          ;(metaUpdates as { comment: string }).comment = comment.trim()
        }
        if (Object.keys(metaUpdates).length > 0) {
          await updateWorktreeMeta(wt.id, metaUpdates as { linkedIssue?: number; comment?: string })
        }
      } catch {
        console.error('Failed to update worktree meta after creation')
      }

      setActiveRepo(repoId)
      setActiveView('terminal')
      setSidebarOpen(true)
      if (searchQuery) {
        setSearchQuery('')
      }
      if (filterRepoIds.length > 0 && !filterRepoIds.includes(repoId)) {
        setFilterRepoIds([])
      }
      setActiveWorktree(wt.id)
      ensureWorktreeHasInitialTerminal(useAppStore.getState(), wt.id, result.setup)
      revealWorktreeInSidebar(wt.id)
      if (settings?.rightSidebarOpenByDefault) {
        setRightSidebarTab('explorer')
        setRightSidebarOpen(true)
      }
      handleOpenChange(false)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to create worktree.'
      setCreateError(message)
      toast.error(message)
    } finally {
      setCreating(false)
      setPendingGitignoreConfirm(false)
    }
  },
  [
    repoId,
    name,
    linkedIssue,
    comment,
    createWorktree,
    updateWorktreeMeta,
    setActiveRepo,
    setActiveView,
    setSidebarOpen,
    searchQuery,
    setSearchQuery,
    filterRepoIds,
    setFilterRepoIds,
    setActiveWorktree,
    revealWorktreeInSidebar,
    setRightSidebarOpen,
    setRightSidebarTab,
    settings?.rightSidebarOpenByDefault,
    handleOpenChange,
    resolvedSetupDecision,
    setupConfig
  ]
)
```

**Dep-array note:** `setPendingGitignoreConfirm`, `setCreating`, and `setCreateError` are deliberately **not** in the dep array. They are React `useState` setters, which React guarantees are stable across renders — the existing file omits them throughout for the same reason. Zustand store setters (`setActiveRepo`, `setActiveView`, etc.) are included because that's the file's existing convention.

- [ ] **Step 11.3: Update `handleCreate` to check gitignore before calling `performCreate`**

Replace `handleCreate` with:

```typescript
const handleCreate = useCallback(async () => {
  if (!repoId || !name.trim() || shouldWaitForSetupCheck || !selectedRepo) {
    return
  }

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
  repoId,
  name,
  shouldWaitForSetupCheck,
  selectedRepo,
  settings?.worktreeLocation,
  performCreate
])
```

(`setPendingGitignoreConfirm` is omitted for the same reason as in Step 11.2 — React `useState` setters are stable and the file's existing convention is to leave them out.)

- [ ] **Step 11.4: Typecheck and lint**

Run:
```bash
pnpm run tc && pnpm run lint
```

Expected: clean. If the lint fails on `exhaustive-deps`, the dep arrays above are wrong and you need to add the flagged variable.

- [ ] **Step 11.5: Commit**

```bash
git add src/renderer/src/components/sidebar/AddWorktreeDialog.tsx
git commit -m "feat: gate AddWorktreeDialog create on gitignore check in in-repo mode"
```

---

## Task 12: Render the inline confirmation pane

**Files:**
- Modify: `src/renderer/src/components/sidebar/AddWorktreeDialog.tsx`

**Why:** When `pendingGitignoreConfirm` is true, the dialog body is replaced by a confirmation prompt with three buttons.

- [ ] **Step 12.1: Add the confirmation pane inside `DialogContent`**

Locate the `<DialogContent>` JSX (around line 389). The current content is:

```tsx
<DialogContent className="max-w-md" onKeyDown={handleKeyDown}>
  <DialogHeader>
    <DialogTitle className="text-sm">New Worktree</DialogTitle>
    <DialogDescription className="text-xs">
      Create a new git worktree on a fresh branch cut from the selected base ref.
    </DialogDescription>
  </DialogHeader>

  <div className="space-y-3">
    {/* ... existing form body ... */}
  </div>

  <DialogFooter>
    {/* ... existing buttons ... */}
  </DialogFooter>
</DialogContent>
```

Wrap the existing `DialogHeader`, form body, and `DialogFooter` in a conditional so the pane can replace them entirely when needed. Change the structure to:

```tsx
<DialogContent className="max-w-md" onKeyDown={handleKeyDown}>
  {pendingGitignoreConfirm ? (
    <>
      <DialogHeader>
        <DialogTitle className="text-sm">
          Add <code>.worktrees/</code> to <code>.gitignore</code>?
        </DialogTitle>
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
          onClick={() => setPendingGitignoreConfirm(false)}
          className="text-xs"
        >
          Cancel
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => performCreate({ addGitignoreEntry: false })}
          disabled={creating}
          className="text-xs"
        >
          {creating ? 'Creating...' : 'Create anyway'}
        </Button>
        <Button
          size="sm"
          onClick={() => performCreate({ addGitignoreEntry: true })}
          disabled={creating}
          className="text-xs"
        >
          {creating ? 'Creating...' : 'Add and create'}
        </Button>
      </DialogFooter>
    </>
  ) : (
    <>
      <DialogHeader>
        <DialogTitle className="text-sm">New Worktree</DialogTitle>
        <DialogDescription className="text-xs">
          Create a new git worktree on a fresh branch cut from the selected base ref.
        </DialogDescription>
      </DialogHeader>

      <div className="space-y-3">
        {/* ... existing form body unchanged ... */}
      </div>

      <DialogFooter>
        {/* ... existing footer buttons unchanged ... */}
      </DialogFooter>
    </>
  )}
</DialogContent>
```

Keep the existing form body and footer buttons exactly as they are — only wrap them in the ternary. The confirmation pane branch is the new content.

- [ ] **Step 12.2: Typecheck and lint**

Run:
```bash
pnpm run tc && pnpm run lint
```

Expected: clean.

- [ ] **Step 12.3: Full test suite (sanity)**

Run:
```bash
pnpm test
```

Expected: all green.

- [ ] **Step 12.4: Commit**

```bash
git add src/renderer/src/components/sidebar/AddWorktreeDialog.tsx
git commit -m "feat: render inline .gitignore confirmation pane in AddWorktreeDialog"
```

---

## Task 13: Update the suggested-name pool flag

**Files:**
- Modify: `src/renderer/src/components/sidebar/AddWorktreeDialog.tsx`

**Why:** In in-repo mode, each repo has its own `.worktrees/` directory, so name conflicts are per-repo just like nested external mode. The suggestion logic needs to know this.

- [ ] **Step 13.1: Derive and use a `namePoolIsPerRepo` flag**

In `AddWorktreeDialog.tsx`, locate the current `suggestedName` block (around line 94-97):

```typescript
const suggestedName = useMemo(
  () => getSuggestedSpaceName(repoId, worktreesByRepo, settings?.nestWorkspaces ?? false),
  [repoId, worktreesByRepo, settings?.nestWorkspaces]
)
```

Replace with:

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

- [ ] **Step 13.2: Rename the parameter inside `getSuggestedSpaceName`**

Locate `getSuggestedSpaceName` (around line 594). Rename its third parameter:

```typescript
function getSuggestedSpaceName(
  repoId: string,
  worktreesByRepo: Record<string, { path: string }[]>,
  perRepoNamePool: boolean
): string {
  // ... existing body ...

  if (!perRepoNamePool) {     // ← was: if (!nestWorkspaces) {
    for (const worktrees of Object.values(worktreesByRepo)) {
      for (const worktree of worktrees) {
        usedNames.add(normalizeSpaceName(lastPathSegment(worktree.path)))
      }
    }
  }

  // ... rest unchanged ...
}
```

The rename is a one-word change in the parameter name and one call site inside the body. The function is file-local (verified during spec review), so no external callers exist.

- [ ] **Step 13.3: Typecheck and lint**

Run:
```bash
pnpm run tc && pnpm run lint
```

Expected: clean.

- [ ] **Step 13.4: Commit**

```bash
git add src/renderer/src/components/sidebar/AddWorktreeDialog.tsx
git commit -m "feat: broaden per-repo name pool to include in-repo worktree mode"
```

---

## Task 14: Reset confirmation state on dialog close

**Files:**
- Modify: `src/renderer/src/components/sidebar/AddWorktreeDialog.tsx`

**Why:** The existing `useEffect` at lines 267-296 resets all dialog state on close with a 200ms delay. Add the new `pendingGitignoreConfirm` to that reset to prevent it leaking between sessions.

- [ ] **Step 14.1: Add `setPendingGitignoreConfirm(false)` to the existing reset callback**

Locate the `useEffect` in `AddWorktreeDialog.tsx` starting at line 267. Inside the `setTimeout` callback at line 277, the body currently clears all dialog state. Add a line to clear the new state:

```typescript
resetTimeoutRef.current = window.setTimeout(() => {
  setRepoId('')
  setName('')
  setLinkedIssue('')
  setComment('')
  setYamlHooks(null)
  setCheckedHooksRepoId(null)
  setSetupDecision(null)
  setCreateError(null)
  setPendingGitignoreConfirm(false)   // ← new line
  lastSuggestedNameRef.current = ''
  resetTimeoutRef.current = null
}, DIALOG_CLOSE_RESET_DELAY_MS)
```

- [ ] **Step 14.2: Typecheck, lint, and full suite**

Run:
```bash
pnpm run tc && pnpm run lint && pnpm test
```

Expected: all green.

- [ ] **Step 14.3: Commit**

```bash
git add src/renderer/src/components/sidebar/AddWorktreeDialog.tsx
git commit -m "fix: reset gitignore confirmation state on dialog close"
```

---

## Task 15: Add the Worktree Location picker to `GeneralPane`

**Files:**
- Modify: `src/renderer/src/components/settings/GeneralPane.tsx`

**Why:** Give users a way to actually switch modes. The picker is a segmented control at the top of the Workspace section; it mirrors the existing `branchPrefix` control.

- [ ] **Step 15.1: Add the Worktree Location picker at the top of the Workspace section**

Open `src/renderer/src/components/settings/GeneralPane.tsx`. Locate the Workspace section (around lines 96-166). It currently renders `Workspace Directory` and `Nest Workspaces`. Insert a new `SearchableSetting` at the top of the section, directly after the `<div>` with the `<h3>Workspace</h3>` header:

```tsx
<section key="workspace" className="space-y-4">
  <div className="space-y-1">
    <h3 className="text-sm font-semibold">Workspace</h3>
    <p className="text-xs text-muted-foreground">
      Configure where new worktrees are created.
    </p>
  </div>

  <SearchableSetting
    title="Worktree Location"
    description="Where Orca creates new worktree directories."
    keywords={['worktree', 'location', 'in-repo', '.worktrees', 'external', 'workspace', 'gitignore']}
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

  {/* ... existing Workspace Directory SearchableSetting below ... */}
  {/* ... existing Nest Workspaces SearchableSetting below ... */}
</section>
```

Leave the existing `Workspace Directory` and `Nest Workspaces` blocks alone for now — Task 16 makes them conditional.

- [ ] **Step 15.2: Typecheck and lint**

Run:
```bash
pnpm run tc && pnpm run lint
```

Expected: clean.

- [ ] **Step 15.3: Commit**

```bash
git add src/renderer/src/components/settings/GeneralPane.tsx
git commit -m "feat: add Worktree Location picker to GeneralPane"
```

---

## Task 16: Conditionally render the existing Workspace controls

**Files:**
- Modify: `src/renderer/src/components/settings/GeneralPane.tsx`

**Why:** When in-repo mode is active, `Workspace Directory` and `Nest Workspaces` are irrelevant for new worktrees. Hide them entirely so the UI isn't confusing.

- [ ] **Step 16.1: Wrap the existing two blocks in a conditional**

In `GeneralPane.tsx`, the `Workspace Directory` and `Nest Workspaces` `SearchableSetting` blocks sit directly after the new picker you added in Task 15. Wrap both of them in a single conditional:

```tsx
{settings.worktreeLocation === 'external' ? (
  <>
    <SearchableSetting
      title="Workspace Directory"
      description="Root directory where worktree folders are created."
      keywords={['workspace', 'folder', 'path', 'worktree']}
      className="space-y-2"
    >
      {/* ... existing content unchanged ... */}
    </SearchableSetting>

    <SearchableSetting
      title="Nest Workspaces"
      description="Create worktrees inside a repo-named subfolder."
      keywords={['nested', 'subfolder', 'directory']}
      className="flex items-center justify-between gap-4 px-1 py-2"
    >
      {/* ... existing content unchanged ... */}
    </SearchableSetting>
  </>
) : null}
```

The inner content of each `SearchableSetting` is unchanged — only the surrounding fragment and the `worktreeLocation === 'external'` check are new.

- [ ] **Step 16.2: Typecheck and lint**

Run:
```bash
pnpm run tc && pnpm run lint
```

Expected: clean.

- [ ] **Step 16.3: Commit**

```bash
git add src/renderer/src/components/settings/GeneralPane.tsx
git commit -m "feat: hide Workspace Directory and Nest Workspaces in in-repo mode"
```

---

## Task 17: Add settings-search entry for the new picker

**Files:**
- Modify: `src/renderer/src/components/settings/general-search.ts`

**Why:** The settings search should surface the new control. Without this step, typing "worktree location" into the settings search box will not highlight the picker.

- [ ] **Step 17.1: Add a new entry to `GENERAL_WORKSPACE_SEARCH_ENTRIES`**

Open `src/renderer/src/components/settings/general-search.ts`. The file uses the type `SettingsSearchEntry` (imported from `./settings-search` at line 1). The exported array is typed `SettingsSearchEntry[]` — do NOT use the wrong type name `SearchEntry` (it does not exist).

Find `GENERAL_WORKSPACE_SEARCH_ENTRIES` (line 3). Add a new entry at the top of the array, then read one of the existing entries to copy the exact field shape — whatever fields the existing entries use, your new entry must use the same fields. Below is the canonical shape; verify it matches the existing entries before pasting:

```typescript
export const GENERAL_WORKSPACE_SEARCH_ENTRIES: SettingsSearchEntry[] = [
  {
    title: 'Worktree Location',
    description: 'Where Orca creates new worktree directories.',
    keywords: ['worktree', 'location', 'in-repo', '.worktrees', 'external', 'workspace', 'gitignore']
  },
  // ... existing entries below ...
]
```

If `SettingsSearchEntry` requires additional fields (e.g. `id`, `category`, `paneId`), add them to your entry to match the existing entries' shape.

- [ ] **Step 17.2: Typecheck and full suite**

Run:
```bash
pnpm run tc && pnpm test
```

Expected: clean.

- [ ] **Step 17.3: Commit**

```bash
git add src/renderer/src/components/settings/general-search.ts
git commit -m "feat: register Worktree Location in settings search"
```

---

## Task 18: Manual smoke test

**Files:** None (this is a verification task).

**Why:** `AddWorktreeDialog` and `GeneralPane` have no unit tests. The end-to-end flow must be exercised manually before declaring the feature done.

- [ ] **Step 18.1: Build and launch the dev app**

Run:
```bash
pnpm run dev
```

Wait for Electron to open.

- [ ] **Step 18.2: Verify the Workspace Location picker**

1. Open Settings (`Cmd+,` on Mac, `Ctrl+,` elsewhere).
2. Navigate to the General pane.
3. Scroll to the Workspace section.
4. **Expected:** The top of the Workspace section shows "Worktree Location" with a segmented control `[External directory | In-repo .worktrees/]`. "External directory" is selected by default. Below the picker, the `Workspace Directory` input and `Nest Workspaces` toggle are visible.

- [ ] **Step 18.3: Toggle to in-repo mode**

1. Click `In-repo .worktrees/`.
2. **Expected:** The Workspace Directory input and Nest Workspaces toggle disappear. The description text changes to mention `<repo>/.worktrees/<name>` and the .gitignore offer.

- [ ] **Step 18.4: Test settings search**

1. Use the settings search box (top of the Settings panel).
2. Type "worktree location".
3. **Expected:** The new picker is highlighted / scrolled into view.

- [ ] **Step 18.5: Create a worktree with gitignore entry missing**

1. Pick a git repo in the sidebar that does **not** have `.worktrees/` in its `.gitignore`.
2. Open the New Worktree dialog (click the "+" button or use the keyboard shortcut).
3. Type a name.
4. Click Create.
5. **Expected:** The dialog body is replaced with the confirmation pane asking to add `.worktrees/` to .gitignore. Three buttons: Cancel / Create anyway / Add and create.

- [ ] **Step 18.6: Pick "Add and create"**

1. Click "Add and create".
2. **Expected:** The worktree is created at `<repo>/.worktrees/<name>`. The repo's `.gitignore` file now contains `.worktrees/` on a new line. The sidebar shows the new worktree. The terminal pane opens pointing to the new worktree directory.

- [ ] **Step 18.7: Create a second worktree — confirmation should NOT appear**

1. Open New Worktree dialog again in the same repo.
2. Type a different name.
3. Click Create.
4. **Expected:** No confirmation pane appears because `.gitignore` already contains the entry. The worktree is created directly.

- [ ] **Step 18.8: Verify the `.gitignore` wasn't duplicated**

Run (outside Orca):
```bash
cat <repo_path>/.gitignore
```

Expected: exactly one `.worktrees/` line.

- [ ] **Step 18.9: Test "Create anyway"**

1. Pick a different git repo that does not have `.worktrees/` in its `.gitignore`.
2. Open New Worktree dialog.
3. Click Create.
4. On the confirmation pane, click "Create anyway".
5. **Expected:** The worktree is created at `<repo>/.worktrees/<name>`. The `.gitignore` is **not** modified. Running `git status` in the repo will show the worktree's files as untracked — this is the expected consequence of creating without ignoring.

- [ ] **Step 18.10: Test Cancel**

1. In the same repo or another without the entry, open New Worktree dialog.
2. Type a name.
3. Click Create.
4. On the confirmation pane, click Cancel.
5. **Expected:** The dialog body switches back to the form (the worktree is not created). Clicking Create again re-opens the confirmation pane.

- [ ] **Step 18.11: Toggle back to external mode and verify round-trip**

1. Open Settings → General → Workspace.
2. Click `External directory`.
3. **Expected:** The Workspace Directory input and Nest Workspaces toggle reappear with their previous values.
4. Close Settings and create another worktree.
5. **Expected:** No confirmation pane; the worktree is created in the workspaceDir (not inside the repo).

- [ ] **Step 18.12: Verify existing in-repo worktrees still work after toggle back**

1. In the sidebar, click one of the in-repo worktrees created earlier.
2. **Expected:** It opens normally. File explorer, terminal, and git operations all work — authorization was never revoked.

- [ ] **Step 18.13: Report results**

If any step above fails, stop and report which step + what happened. All steps should pass before moving on.

- [ ] **Step 18.14: (no commit)**

Manual test — no code change, no commit.

---

## Self-Review Checklist

Before handing off to review:

- [ ] **Spec coverage** — skim `docs/in-repo-worktrees-design.md`. Every section should map to a task:
  - Data model → Task 1
  - `isBareRepo` helper → Task 2
  - Gitignore module → Tasks 3, 4
  - `computeWorktreePath` refactor → Task 5
  - `worktrees.ts` calling code → Task 6
  - IPC handlers → Tasks 7, 8
  - Preload bridge → Task 9
  - `AddWorktreeDialog` → Tasks 10, 11, 12, 13, 14
  - `GeneralPane` → Tasks 15, 16, 17
  - Manual smoke test → Task 18

- [ ] **Full suite + typecheck one more time**

  ```bash
  pnpm test && pnpm run tc && pnpm run lint
  ```

  Expected: all clean.

- [ ] **Commit log sanity**

  ```bash
  git log --oneline main..HEAD
  ```

  Expected: ~17-18 commits, each with a focused message. No "wip", no "fix typo", no squash markers.

---

## What to tell the reviewer

"Implements the in-repo `.worktrees/` mode per `docs/in-repo-worktrees-design.md`. Every task is a separate commit. Unit tests cover the pure parsing, IO wrappers, path computation (all three modes), and the two new IPC handlers. `AddWorktreeDialog` and `GeneralPane` do not have dedicated unit tests; they are verified via typecheck + manual smoke test (Task 18 above). The refactor of `computeWorktreePath` also adds path validation to the WSL branch — this is net-new behavior, covered by a new regression test."
