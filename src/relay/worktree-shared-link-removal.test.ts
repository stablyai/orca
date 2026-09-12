import { executeWslWorktreePathOperation } from './wsl-worktree-path-operation'
import { mkdtemp, mkdir, writeFile, symlink, lstat, rm, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { runProcess } from '../shared/child-process/run-process'
import { GitCapabilityCache } from '../shared/git-capability-cache'
import { resolveRelayRemovableSharedLinks } from './worktree-shared-link-removal'
import { removeWorktreeOp } from './git-handler-worktree-remove'
import { worktreeIsCleanOp } from './git-handler-worktree-ops'
import type { GitExec } from './git-handler-ops'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
const git: GitExec = async (args, cwd) => {
  const result = await runProcess({
    program: 'git',
    args,
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'CoW test',
      GIT_AUTHOR_EMAIL: 'cow@example.invalid',
      GIT_COMMITTER_NAME: 'CoW test',
      GIT_COMMITTER_EMAIL: 'cow@example.invalid'
    }
  })
  if (result.code !== 0) {
    throw new Error(result.stderr)
  }
  return { stdout: result.stdout, stderr: result.stderr }
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'orca-cow-remove-'))
  roots.push(root)
  const source = join(root, 'source'),
    target = join(root, 'target')
  await mkdir(source)
  await git(['init', '-q'], source)
  await writeFile(join(source, 'tracked'), 'original')
  await writeFile(join(source, 'orca.yaml'), 'worktree:\n  sharedDirectories:\n    - deps\n')
  await writeFile(join(source, '.gitignore'), 'deps/\n')
  await git(['add', '.'], source)
  await git(['commit', '-qm', 'fixture'], source)
  await git(['worktree', 'add', '-qb', 'feature', target], source)
  await mkdir(join(source, 'deps'))
  await writeFile(join(source, 'deps', 'value'), 'shared')
  await symlink(
    join(source, 'deps'),
    join(target, 'deps'),
    process.platform === 'win32' ? 'junction' : 'dir'
  )
  return { source, target, sharedLinks: { source, paths: [] } }
}

describe('host-owned shared-link removal', () => {
  it('removes a real clean worktree with a directory-only ignored shared link', async () => {
    const { source, target, sharedLinks } = await fixture()
    expect((await worktreeIsCleanOp(git, { worktreePath: target })).clean).toBe(false)
    expect((await worktreeIsCleanOp(git, { worktreePath: target, sharedLinks })).clean).toBe(true)
    await removeWorktreeOp(
      git,
      { worktreePath: target, sharedLinks, deleteBranch: false },
      new GitCapabilityCache()
    )
    await expect(lstat(target)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(join(source, 'deps', 'value'), 'utf8')).toBe('shared')
  })
  it('does not unlink anything when other files are dirty', async () => {
    const { target, sharedLinks } = await fixture()
    await writeFile(join(target, 'tracked'), 'changed')
    expect((await worktreeIsCleanOp(git, { worktreePath: target, sharedLinks })).clean).toBe(false)
    await expect(
      removeWorktreeOp(git, { worktreePath: target, sharedLinks }, new GitCapabilityCache())
    ).rejects.toThrow('uncommitted')
    expect((await lstat(join(target, 'deps'))).isSymbolicLink()).toBe(true)
  })
  it('keeps configured regular files subject to the normal dirty check', async () => {
    const { target, sharedLinks } = await fixture()
    await rm(join(target, 'deps'))
    await writeFile(join(target, 'deps'), 'user-owned')
    expect((await worktreeIsCleanOp(git, { worktreePath: target, sharedLinks })).clean).toBe(false)
    await expect(
      removeWorktreeOp(git, { worktreePath: target, sharedLinks }, new GitCapabilityCache())
    ).rejects.toThrow()
    expect(await readFile(join(target, 'deps'), 'utf8')).toBe('user-owned')
  })
  it('never classifies a tracked configured symlink as removable', async () => {
    const { target, sharedLinks } = await fixture()
    await git(['add', '-f', 'deps'], target)
    await git(['commit', '-qm', 'track link'], target)
    expect(await resolveRelayRemovableSharedLinks(git, target, sharedLinks)).toEqual([])
    await writeFile(join(target, 'tracked'), 'dirty')
    await expect(
      removeWorktreeOp(git, { worktreePath: target, sharedLinks }, new GitCapabilityCache())
    ).rejects.toThrow()
    expect((await lstat(join(target, 'deps'))).isSymbolicLink()).toBe(true)
  })
  it('treats configured pathspec metacharacters as literal filenames', async () => {
    const { target, source } = await fixture()
    await symlink('tracked', join(target, '[owned]'))
    await git(['--literal-pathspecs', 'add', '--', '[owned]'], target)
    await git(['commit', '-qm', 'track literal link'], target)
    expect(
      await resolveRelayRemovableSharedLinks(git, target, { source, paths: ['[owned]'] })
    ).not.toContain('[owned]')
  })
  it('inspects WSL links without mutation, then removes only links on the guest', async () => {
    const { source, target } = await fixture()
    const request = { source, target, linkedPaths: [] }
    expect(
      await executeWslWorktreePathOperation({ ...request, operation: 'inspect-links' })
    ).toEqual({ supported: true, paths: ['deps'] })
    expect((await lstat(join(target, 'deps'))).isSymbolicLink()).toBe(true)
    expect(
      await executeWslWorktreePathOperation({ ...request, operation: 'remove-links' })
    ).toEqual({ supported: true, paths: ['deps'] })
    await expect(lstat(join(target, 'deps'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(join(source, 'deps', 'value'), 'utf8')).toBe('shared')
    expect(await readFile(join(target, 'tracked'), 'utf8')).toBe('original')
  })

  it('rejects unknown WSL operations without touching paths', async () => {
    await expect(
      executeWslWorktreePathOperation({ operation: 'erase', target: '/tmp' })
    ).rejects.toThrow('Invalid')
  })
})
