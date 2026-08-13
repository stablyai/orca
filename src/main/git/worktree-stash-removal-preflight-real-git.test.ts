// Real-binary coverage for #13695 adjacency: a stashed worktree reports clean
// porcelain, so delete preflight must refuse non-force removal when stash
// subjects were recorded on that worktree's branch (shared refs/stash).
// Branch attribution is not ownership — subjects may originate elsewhere.
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  WORKTREE_STASH_REMOVAL_DETAIL_PREFIX,
  WORKTREE_STASH_REMOVAL_ERROR,
  WORKTREE_STASH_VERIFICATION_ERROR
} from '../../shared/git-stash-branch-attribution'
import {
  assertBranchAttributedStashSafeForRemoval,
  assertWorktreeCleanForRemoval,
  removeWorktree
} from './worktree'

const execFileAsync = promisify(execFile)

let scratchDir = ''
let repoPath = ''
let worktreeA = ''
let worktreeB = ''

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd })
  return stdout
}

beforeEach(async () => {
  scratchDir = await realpath(await mkdtemp(join(tmpdir(), 'orca-stash-removal-preflight-')))
  repoPath = join(scratchDir, 'repo')
  worktreeA = join(scratchDir, 'wt-a')
  worktreeB = join(scratchDir, 'wt-b')
  await mkdir(repoPath, { recursive: true })
  await git(['init', '-q'], repoPath)
  await git(['config', 'user.email', 'stash-preflight@example.invalid'], repoPath)
  await git(['config', 'user.name', 'Stash Preflight'], repoPath)
  await writeFile(join(repoPath, 'shared.txt'), 'line1\n')
  await git(['add', '-A'], repoPath)
  await git(['commit', '-qm', 'init'], repoPath)
  await git(['worktree', 'add', '-q', worktreeA, '-b', 'agent-a'], repoPath)
  await git(['worktree', 'add', '-q', worktreeB, '-b', 'agent-b'], repoPath)
})

afterEach(async () => {
  await rm(scratchDir, { recursive: true, force: true })
})

describe('worktree stash removal preflight against real Git', () => {
  it('refuses non-force removal when the worktree is clean but branch-attributed stash remains', async () => {
    await writeFile(join(worktreeA, 'shared.txt'), 'line1\nIMPORTANT agent A WIP\n')
    await git(['stash', 'push', '-m', 'agent-a: refactor WIP'], worktreeA)
    expect((await git(['status', '--porcelain'], worktreeA)).trim()).toBe('')
    expect(await git(['stash', 'list'], worktreeA)).toContain('agent-a')

    await expect(assertWorktreeCleanForRemoval(worktreeA, false)).rejects.toMatchObject({
      message: WORKTREE_STASH_REMOVAL_ERROR,
      stdout: expect.stringContaining(WORKTREE_STASH_REMOVAL_DETAIL_PREFIX)
    })

    await expect(
      removeWorktree(repoPath, worktreeA, false, { deleteBranch: false })
    ).rejects.toThrow(WORKTREE_STASH_REMOVAL_ERROR)
    // Why normalize: Git on Windows lists worktrees with `/`, Node paths use `\`.
    const listed = (await git(['worktree', 'list'], repoPath)).replace(/\\/g, '/')
    expect(listed).toContain(worktreeA.replace(/\\/g, '/'))
    expect(await git(['stash', 'list'], repoPath)).toContain('agent-a')
  })

  it('does not block removal for a sibling worktree whose branch has no matching stash subjects', async () => {
    await writeFile(join(worktreeA, 'shared.txt'), 'line1\nagent A only\n')
    await git(['stash', 'push', '-m', 'agent-a WIP'], worktreeA)

    await expect(assertWorktreeCleanForRemoval(worktreeB, false)).resolves.toBeUndefined()
  })

  it('allows force removal while leaving the shared stash entry intact', async () => {
    await writeFile(join(worktreeA, 'shared.txt'), 'line1\nforce path\n')
    await git(['stash', 'push', '-m', 'agent-a force'], worktreeA)

    await expect(assertWorktreeCleanForRemoval(worktreeA, true)).resolves.toBeUndefined()
    await removeWorktree(repoPath, worktreeA, true, { deleteBranch: false })

    const listed = (await git(['worktree', 'list'], repoPath)).replace(/\\/g, '/')
    expect(listed).not.toContain(worktreeA.replace(/\\/g, '/'))
    expect(await git(['stash', 'list'], repoPath)).toContain('agent-a force')
  })

  it('skips stash attribution when the worktree is detached (no inventable branch)', async () => {
    await git(['checkout', '--detach', 'HEAD'], worktreeA)
    await writeFile(join(worktreeA, 'shared.txt'), 'line1\ndetached WIP\n')
    await git(['stash', 'push', '-m', 'detached WIP'], worktreeA)

    // Known empty branch: no attribution probe invents a match against "On (no branch)".
    await expect(
      assertBranchAttributedStashSafeForRemoval(worktreeA, '')
    ).resolves.toBeUndefined()
  })

  it('reproduces cross-worktree pop theft so the remaining hazard stays documented', async () => {
    await writeFile(
      join(worktreeA, 'shared.txt'),
      'line1\nIMPORTANT half-finished refactor by agent A\n'
    )
    await git(['stash', 'push', '-m', 'agent-a: refactor WIP'], worktreeA)
    await git(['stash', 'pop'], worktreeB)

    expect((await git(['status', '--porcelain'], worktreeA)).trim()).toBe('')
    expect((await git(['status', '--porcelain'], worktreeB)).trim()).toContain('shared.txt')
    const bContent = await readFile(join(worktreeB, 'shared.txt'), 'utf8')
    expect(bContent).toContain('IMPORTANT half-finished refactor by agent A')
    expect((await git(['stash', 'list'], worktreeA)).trim()).toBe('')
  })
})

// Keep the verification constant referenced so renames break this file loudly.
void WORKTREE_STASH_VERIFICATION_ERROR
