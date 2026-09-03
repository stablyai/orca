/**
 * Issue #18280: the SSH relay used to carry its own copies of the worktree-list and
 * unmerged-entry porcelain parsers, and they drifted — the relay copy had no `sparse`
 * branch and never C-quote-decoded a conflict path. These tests push one porcelain
 * fixture through the relay's published call sites and the desktop's, and require the
 * answers to be identical. A second parser reintroduced on either side fails here.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseWorktreeList } from '../main/git/worktree'
import type { GitStatusEntry } from '../shared/git-status-types'
import type { GitWorktreeInfo } from '../shared/worktree/types'
import { parseUnmergedEntry } from '../shared/git-status-conflict-entries'
import { RelayContext } from './context'
import { GitHandler } from './git-handler'
import { getStatusOp } from './git-handler-status-ops'
import type { GitExec } from './git-handler-ops'
import type { RelayGitStreamExec } from './git-stdout-stream'
import {
  createMockDispatcher,
  type MockDispatcher,
  type RelayDispatcher
} from './git-handler-test-setup'

type GitSpyTarget = {
  git(args: string[], cwd: string): Promise<{ stdout: string; stderr: string }>
}

const tempRoots: string[] = []

async function createTempDir(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), prefix))
  tempRoots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function createWorktreeFixture(prefix: string): Promise<string> {
  const mainPath = await createTempDir(prefix)
  // Why: the Git <2.36 fallback lane probes each linked path's existence; a missing
  // directory would add a relay-only `prunable` annotation and muddy the comparison.
  await mkdir(path.join(mainPath, 'sparse-wt'))
  await mkdir(path.join(mainPath, 'locked-wt'))
  return mainPath
}

async function listWorktreesOverRelay(
  mainPath: string,
  git: (args: string[]) => Promise<{ stdout: string; stderr: string }>
): Promise<GitWorktreeInfo[]> {
  const { dispatcher, handler } = createRelay()
  vi.spyOn(handler as unknown as GitSpyTarget, 'git').mockImplementation(git)
  return (await dispatcher.callRequest('git.listWorktrees', {
    repoPath: mainPath
  })) as GitWorktreeInfo[]
}

function buildWorktreePorcelainBlocks(mainPath: string): string[][] {
  return [
    [`worktree ${mainPath}`, 'HEAD abc123', 'branch refs/heads/main'],
    // `sparse` is Git 2.28+; older hosts omit the line and `isSparse` is correctly absent.
    [
      `worktree ${path.join(mainPath, 'sparse-wt')}`,
      'HEAD def456',
      'branch refs/heads/sparse',
      'sparse'
    ],
    [
      `worktree ${path.join(mainPath, 'locked-wt')}`,
      'HEAD 111111',
      'branch refs/heads/locked',
      'locked "held \\303\\251"'
    ],
    [
      `worktree ${path.join(mainPath, 'stale-wt')}`,
      'HEAD 222222',
      'branch refs/heads/stale',
      'prunable gitdir file points to non-existent location'
    ]
  ]
}

function toLinePorcelain(blocks: string[][]): string {
  return `${blocks.map((block) => block.join('\n')).join('\n\n')}\n`
}

function toNulPorcelain(blocks: string[][]): string {
  // Git's `-z` porcelain terminates every field with NUL and every block with an extra NUL.
  return blocks.map((block) => `${block.join('\0')}\0\0`).join('')
}

/** Git <2.36 rejects `worktree list -z` with a usage error, routing the handler to the fallback lane. */
function unsupportedZError(): Error {
  return Object.assign(new Error('git usage error'), {
    code: 129,
    stderr: 'usage: git worktree list [<options>]\n'
  })
}

function createRelay(): { dispatcher: MockDispatcher; handler: GitHandler } {
  const dispatcher = createMockDispatcher()
  const handler = new GitHandler(dispatcher as unknown as RelayDispatcher, new RelayContext())
  return { dispatcher, handler }
}

describe('relay/desktop worktree-list porcelain parity', () => {
  it('answers the -z lane with exactly what the desktop parser produces, including isSparse', async () => {
    const mainPath = await createWorktreeFixture('orca-parity-wt-')
    const porcelain = toNulPorcelain(buildWorktreePorcelainBlocks(mainPath))

    const relayWorktrees = await listWorktreesOverRelay(mainPath, async () => ({
      stdout: porcelain,
      stderr: ''
    }))

    expect(relayWorktrees).toEqual(parseWorktreeList(porcelain, { nulDelimited: true }))
    expect(relayWorktrees[1]).toMatchObject({ branch: 'refs/heads/sparse', isSparse: true })
  })

  it('answers the Git <2.36 fallback lane identically', async () => {
    const mainPath = await createWorktreeFixture('orca-parity-wt-fallback-')
    const porcelain = toLinePorcelain(buildWorktreePorcelainBlocks(mainPath))

    const relayWorktrees = await listWorktreesOverRelay(mainPath, async (args) => {
      if (args.includes('-z')) {
        throw unsupportedZError()
      }
      return { stdout: porcelain, stderr: '' }
    })

    expect(relayWorktrees).toEqual(parseWorktreeList(porcelain))
    expect(relayWorktrees[1]).toMatchObject({ isSparse: true })
  })

  it('leaves isSparse absent on a Git 2.25 host that never emits the sparse line', async () => {
    const mainPath = await createTempDir('orca-parity-wt-baseline-')
    const porcelain = toNulPorcelain([
      [`worktree ${mainPath}`, 'HEAD abc123', 'branch refs/heads/main']
    ])

    const relayWorktrees = await listWorktreesOverRelay(mainPath, async () => ({
      stdout: porcelain,
      stderr: ''
    }))

    expect(relayWorktrees).toEqual(parseWorktreeList(porcelain, { nulDelimited: true }))
    expect(relayWorktrees[0]).not.toHaveProperty('isSparse')
  })
})

describe('relay/desktop unmerged-entry porcelain parity', () => {
  it('resolves C-quoted conflict paths and the working-tree probe the same way', async () => {
    const worktreePath = await createTempDir('orca-parity-conflict-')
    await writeFile(path.join(worktreePath, 'present é.ts'), 'conflict\n')
    const unmergedLines = [
      'u UU N... 100644 100644 100644 100644 aa bb cc plain.ts',
      'u UD N... 100644 100644 000000 100644 aa bb cc "present \\303\\251.ts"',
      'u UD N... 100644 100644 000000 100644 aa bb cc "missing \\303\\251.ts"',
      'u DD N... 100644 100644 000000 000000 aa bb cc both-gone.ts'
    ]
    const git = vi.fn<GitExec>(async (args) => {
      if (args.includes('status')) {
        return { stdout: `${unmergedLines.join('\n')}\n`, stderr: '' }
      }
      throw new Error(`Unexpected git command: ${args.join(' ')}`)
    })
    const streamGit: RelayGitStreamExec = async (args, cwd, options) => {
      const { stdout } = await git(args, cwd, { signal: options.signal })
      return { stoppedEarly: options.onStdout(stdout) === true }
    }

    const relayResult = await getStatusOp(git, streamGit, {
      worktreePath,
      includeLineStats: false
    })

    const desktopEntries: (GitStatusEntry | null)[] = []
    for (const line of unmergedLines) {
      desktopEntries.push(await parseUnmergedEntry(worktreePath, line))
    }

    expect(relayResult.entries).toEqual(desktopEntries)
    expect(relayResult.entries).toEqual([
      {
        path: 'plain.ts',
        area: 'unstaged',
        status: 'modified',
        conflictKind: 'both_modified',
        conflictStatus: 'unresolved'
      },
      {
        path: 'present é.ts',
        area: 'unstaged',
        status: 'modified',
        conflictKind: 'deleted_by_them',
        conflictStatus: 'unresolved'
      },
      {
        path: 'missing é.ts',
        area: 'unstaged',
        status: 'deleted',
        conflictKind: 'deleted_by_them',
        conflictStatus: 'unresolved'
      },
      {
        path: 'both-gone.ts',
        area: 'unstaged',
        status: 'deleted',
        conflictKind: 'both_deleted',
        conflictStatus: 'unresolved'
      }
    ])
  })

  it('drops submodule conflicts on both paths', async () => {
    const worktreePath = await createTempDir('orca-parity-conflict-submodule-')
    const line = 'u UU S... 160000 160000 160000 160000 aa bb cc vendor/submodule'
    const git = vi.fn<GitExec>(async (args) => {
      if (args.includes('status')) {
        return { stdout: `${line}\n`, stderr: '' }
      }
      throw new Error(`Unexpected git command: ${args.join(' ')}`)
    })
    const streamGit: RelayGitStreamExec = async (args, cwd, options) => {
      const { stdout } = await git(args, cwd, { signal: options.signal })
      return { stoppedEarly: options.onStdout(stdout) === true }
    }

    const relayResult = await getStatusOp(git, streamGit, {
      worktreePath,
      includeLineStats: false
    })

    expect(await parseUnmergedEntry(worktreePath, line)).toBeNull()
    expect(relayResult.entries).toEqual([])
  })
})
