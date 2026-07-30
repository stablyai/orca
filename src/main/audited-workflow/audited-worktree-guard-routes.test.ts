// Table-driven proof that every Orca Git-mutation route consults the audited
// worktree guard. Reads the real sources, so a NEW unguarded route fails here
// rather than silently slipping through.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const SRC = join(__dirname, '..', '..')

function read(relativePath: string): string {
  return readFileSync(join(SRC, relativePath), 'utf8')
}

// Every git-mutating IPC channel in filesystem.ts.
const IPC_GIT_MUTATION_CHANNELS = [
  'git:appendGitignore',
  'git:abortMerge',
  'git:abortRebase',
  'git:commit',
  'git:fetch',
  'git:syncFork',
  'git:push',
  'git:pull',
  'git:fastForward',
  'git:rebaseFromBase',
  'git:stage',
  'git:unstage',
  'git:discard',
  'git:bulkDiscard',
  'git:bulkStage',
  'git:bulkUnstage'
] as const

const IPC_WORKTREE_MUTATION_CHANNELS = [
  'worktrees:remove',
  'worktrees:forgetLocal',
  'worktrees:forceDeletePreservedBranch'
] as const

// Every git-mutating runtime RPC method implementation.
const RPC_GIT_MUTATION_METHODS = [
  'abortRuntimeGitMerge',
  'abortRuntimeGitRebase',
  'checkoutRuntimeGitBranch',
  'fetchRuntimeGit',
  'syncRuntimeGitForkDefaultBranch',
  'pullRuntimeGit',
  'fastForwardRuntimeGit',
  'rebaseRuntimeGitFromBase',
  'pushRuntimeGit',
  'commitRuntimeGit',
  'stageRuntimeGitPath',
  'unstageRuntimeGitPath',
  'bulkStageRuntimeGitPaths',
  'bulkUnstageRuntimeGitPaths',
  'bulkDiscardRuntimeGitPaths',
  'discardRuntimeGitPath'
] as const

const RUNTIME_WORKTREE_MUTATION_METHODS = [
  'removeManagedWorktree',
  'forceDeletePreservedBranch'
] as const

/** Body of a handler/method, from its anchor up to the next sibling. */
function sliceAfter(source: string, anchor: string, length = 1600): string {
  const index = source.indexOf(anchor)
  expect(index, `anchor not found: ${anchor}`).toBeGreaterThan(-1)
  return source.slice(index, index + length)
}

describe('every Orca git-mutation route consults the audited worktree guard', () => {
  const filesystem = read('main/ipc/filesystem.ts')
  const worktrees = read('main/ipc/worktrees.ts')
  const runtimeGit = read('main/runtime/orca-runtime-git.ts')
  const runtime = read('main/runtime/orca-runtime.ts')

  it.each(IPC_GIT_MUTATION_CHANNELS)('guards the IPC channel %s', (channel) => {
    const body = sliceAfter(filesystem, `    '${channel}',`)
    const guarded =
      body.includes('assertGitMutationAllowed(args.worktreePath)') ||
      body.includes('isAuditedWorktreeGitMutationRefused(args.worktreePath)')
    expect(guarded, `${channel} is not guarded`).toBe(true)
  })

  it.each(IPC_WORKTREE_MUTATION_CHANNELS)('guards the IPC channel %s', (channel) => {
    const body = sliceAfter(worktrees, `    '${channel}',`)
    expect(body.includes('assertGitMutationAllowed(worktreePath)'), `${channel} is not guarded`).toBe(
      true
    )
  })

  it.each(RPC_GIT_MUTATION_METHODS)('guards the RPC method %s', (method) => {
    const body = sliceAfter(runtimeGit, `async ${method}(`)
    expect(
      body.includes('assertGitMutationAllowed(target.worktree.path)'),
      `${method} is not guarded`
    ).toBe(true)
  })

  it.each(RUNTIME_WORKTREE_MUTATION_METHODS)('guards the runtime method %s', (method) => {
    const body = sliceAfter(runtime, `async ${method}(`)
    expect(
      body.includes('assertGitMutationAllowed(removalTarget.path)'),
      `${method} is not guarded`
    ).toBe(true)
  })

  it('guards every git-mutating channel that filesystem.ts actually registers', () => {
    // Catches a NEW mutating channel added without a guard: any handler whose
    // body calls a known mutation primitive must also call the guard.
    const MUTATION_PRIMITIVES = [
      'commitChanges(',
      'gitPush(',
      'gitPull(',
      'gitFetch(',
      'gitFastForward(',
      'gitPullRebaseFromBase(',
      'stageFile(',
      'unstageFile(',
      'discardChanges(',
      'bulkStageFiles(',
      'bulkUnstageFiles(',
      'bulkDiscardChanges(',
      'abortMerge(',
      'abortRebase(',
      'gitSyncForkDefaultBranch('
    ]
    const registrations = filesystem.split("  ipcMain.handle(").slice(1)
    const unguarded = registrations
      .filter((body) => MUTATION_PRIMITIVES.some((primitive) => body.includes(primitive)))
      .filter(
        (body) =>
          !body.includes('assertGitMutationAllowed(') &&
          !body.includes('isAuditedWorktreeGitMutationRefused(')
      )
      .map((body) => body.slice(0, body.indexOf('\n')).trim())

    expect(unguarded).toEqual([])
  })

  it('does not modify the general-purpose git primitives', () => {
    // The guard lives at Orca's boundaries only, so unrelated internal callers
    // never get an audited-specific throw.
    for (const path of ['main/git/remote.ts', 'main/git/status.ts', 'main/git/checkout.ts']) {
      expect(read(path)).not.toContain('audited-worktree-authority-guard')
    }
  })
})
