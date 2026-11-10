import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runProcess } from '@orca/process-host'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openCheckpointRepo, type CheckpointRepo } from './worktree-checkpoint-git'
import { captureWorktreeCheckpoint, readWorktreeCheckpoint } from './worktree-checkpoint-snapshot'
import { previewWorktreeRestore, restoreWorktreeCheckpoint } from './worktree-checkpoint-restore'
import { listCheckpointRefs, pruneCheckpointRefs } from './worktree-checkpoint-retention'

let dir: string
let repo: CheckpointRepo

async function git(...args: string[]): Promise<string> {
  const result = await runProcess({ program: 'git', args, cwd: dir })
  if (result.code !== 0) {
    throw new Error(result.stderr)
  }
  return result.stdout.trim()
}
const put = async (path: string, text: string | Buffer) => {
  await mkdir(join(dir, path, '..'), { recursive: true })
  await writeFile(join(dir, path), text)
}
const read = (path: string) => readFile(join(dir, path), 'utf8')
const T1 = 'refs/orca/checkpoints/s1/turn/t1'
const NOW = 1_800_000_000_000
const capture = (ref = T1) => captureWorktreeCheckpoint(repo, ref, { kind: 'turn', createdAt: NOW })
const restore = async (ref = T1) => {
  const target = await readWorktreeCheckpoint(repo, ref)
  return restoreWorktreeCheckpoint(repo, target!, {
    ref: 'refs/orca/checkpoints/s1/undo/u1',
    now: 2
  })
}
async function userState() {
  return {
    head: await git('rev-parse', 'HEAD'),
    branch: await git('branch', '--show-current'),
    staged: await git('diff', '--cached', '--name-status'),
    stash: await git('stash', 'list'),
    status: await git('status', '--porcelain=v1', '-uall')
  }
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'orca-checkpoint-'))
  await git('init', '-q')
  await git('symbolic-ref', 'HEAD', 'refs/heads/main')
  await git('config', 'user.name', 'Audit')
  await git('config', 'user.email', 'audit@example.test')
  await git('config', 'commit.gpgsign', 'true')
  await git('config', 'core.hooksPath', '/nonexistent')
  await put('.gitignore', 'ignored/\n*.log\n')
  await put('a.txt', 'a1\n')
  await put('keep/b.txt', 'b1\n')
  await git('add', '.')
  await git('-c', 'commit.gpgsign=false', 'commit', '-qm', 'base')
  repo = await openCheckpointRepo(dir)
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('worktree checkpoints', () => {
  it('snapshots without touching HEAD, branch, index, stash or status', async () => {
    await put('a.txt', 'a2\n')
    await git('add', 'a.txt')
    await put('a.txt', 'a3\n')
    await put('new.txt', 'untracked\n')
    const before = await userState()
    const checkpoint = await capture()
    expect(await userState()).toEqual(before)
    expect(checkpoint.head).toBe(before.head)
    expect(await git('show', `${checkpoint.commit}:a.txt`)).toBe('a3')
    expect(await git('show', `${checkpoint.commit}:new.txt`)).toBe('untracked')
    expect(await git('show', `${checkpoint.indexTree}:a.txt`)).toBe('a2')
    expect(await git('for-each-ref', '--format=%(refname)')).toContain(T1)
    expect(existsSync(join(dir, '.git', 'index.lock'))).toBe(false)
  })

  it('sees a same-size edit made in the same second the index was written (racy git)', async () => {
    // Git rehashes an entry whose stat matches only when it is not older than the index file. A
    // temp index stamped "now" (a later second) would trust the stale stat and drop the edit.
    // Racy git is about real file-system seconds: start early in one so the edit shares it.
    // ast-grep-ignore: test-no-polling-loop, test-no-wall-clock -- the file system clock is real
    while (Date.now() % 1000 > 300) {
      // ast-grep-ignore: test-no-real-time-wait -- the file system clock can't be faked
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    await put('a.txt', 'r1\n')
    await git('add', 'a.txt')
    await put('a.txt', 's1\n')
    // ast-grep-ignore: test-no-real-time-wait -- the snapshot must run in a later second
    await new Promise((resolve) => setTimeout(resolve, 1100))
    const checkpoint = await capture()
    expect(await git('show', `${checkpoint.commit}:a.txt`)).toBe('s1')
  })

  it('restores untracked, deleted, binary, renamed and modified files', async () => {
    const binary = Buffer.from([0, 1, 2, 255, 254, 0, 10])
    await put('bin.dat', binary)
    await put('untracked.txt', 'u1\n')
    await capture()
    await put('a.txt', 'changed\n')
    await rm(join(dir, 'untracked.txt'))
    await put('bin.dat', Buffer.from([9, 9]))
    await mkdir(join(dir, 'moved'))
    await git('mv', 'keep/b.txt', 'moved/b.txt')
    await put('agent-new/deep.txt', 'agent\n')
    const preview = await previewWorktreeRestore(repo, (await readWorktreeCheckpoint(repo, T1))!)
    expect(preview.changes.map((c) => `${c.status} ${c.path}`).sort()).toEqual([
      'A keep/b.txt',
      'A untracked.txt',
      'D agent-new/deep.txt',
      'D moved/b.txt',
      'M a.txt',
      'M bin.dat'
    ])
    const result = await restore()
    expect(result.changes).toHaveLength(6)
    expect(await read('a.txt')).toBe('a1\n')
    expect(await read('untracked.txt')).toBe('u1\n')
    expect(await readFile(join(dir, 'bin.dat'))).toEqual(binary)
    expect(await read('keep/b.txt')).toBe('b1\n')
    expect(existsSync(join(dir, 'moved'))).toBe(false)
    expect(existsSync(join(dir, 'agent-new'))).toBe(false)
    // The staged rename is gone from the index too: HEAD never moved, so staging comes back.
    expect(result.indexRestored).toBe(true)
    expect(await git('diff', '--cached', '--name-status')).toBe('')
    expect(await git('status', '--porcelain=v1')).toBe('?? bin.dat\n?? untracked.txt'.trim())
    expect((await previewWorktreeRestore(repo, (await readWorktreeCheckpoint(repo, T1))!)).changes)
      .toEqual([])
  })

  it('leaves gitignored files alone', async () => {
    await put('ignored/cache.bin', 'before\n')
    await put('debug.log', 'log1\n')
    await capture()
    await put('ignored/cache.bin', 'after\n')
    await put('ignored/new.bin', 'new\n')
    await put('debug.log', 'log2\n')
    await put('a.txt', 'changed\n')
    await restore()
    expect(await read('ignored/cache.bin')).toBe('after\n')
    expect(await read('ignored/new.bin')).toBe('new\n')
    expect(await read('debug.log')).toBe('log2\n')
    expect(await read('a.txt')).toBe('a1\n')
  })

  it('brings back a dirty index while HEAD is unchanged', async () => {
    await put('a.txt', 'staged\n')
    await git('add', 'a.txt')
    await put('a.txt', 'staged-then-edited\n')
    await capture()
    await git('reset', '-q')
    await put('a.txt', 'agent\n')
    const result = await restore()
    expect(result.indexRestored).toBe(true)
    expect(await git('show', ':a.txt')).toBe('staged')
    expect(await read('a.txt')).toBe('staged-then-edited\n')
  })

  it('keeps commits made after the checkpoint and leaves the index when HEAD moved', async () => {
    await capture()
    const base = await git('rev-parse', 'HEAD')
    await put('a.txt', 'committed\n')
    await git('-c', 'commit.gpgsign=false', 'commit', '-qam', 'agent commit')
    const agentHead = await git('rev-parse', 'HEAD')
    const result = await restore()
    expect(result.headMoved).toBe(true)
    expect(result.indexRestored).toBe(false)
    expect(await git('rev-parse', 'HEAD')).toBe(agentHead)
    expect(agentHead).not.toBe(base)
    expect(await read('a.txt')).toBe('a1\n')
  })

  it('undoes a restore, including an ignored file the restore overwrote', async () => {
    await put('later-ignored.txt', 'v1\n')
    await capture()
    await put('.gitignore', 'ignored/\n*.log\nlater-ignored.txt\n')
    await put('later-ignored.txt', 'precious\n')
    await put('a.txt', 'agent\n')
    const result = await restore()
    expect(await read('later-ignored.txt')).toBe('v1\n')
    const undo = await readWorktreeCheckpoint(repo, result.undo.ref)
    await restoreWorktreeCheckpoint(repo, undo!, {
      ref: 'refs/orca/checkpoints/s1/undo/u2',
      now: 3
    })
    expect(await read('later-ignored.txt')).toBe('precious\n')
    expect(await read('a.txt')).toBe('agent\n')
    expect(await read('.gitignore')).toContain('later-ignored.txt')
  })

  it('restores file modes and symlinks', async () => {
    await put('run.sh', '#!/bin/sh\n')
    await chmod(join(dir, 'run.sh'), 0o755)
    await symlink('a.txt', join(dir, 'link'))
    await capture()
    await chmod(join(dir, 'run.sh'), 0o644)
    await rm(join(dir, 'link'))
    await put('link', 'now a file\n')
    await restore()
    expect((await stat(join(dir, 'run.sh'))).mode & 0o111).not.toBe(0)
    expect(await read('link')).toBe('a1\n')
  })

  it('refuses while merge conflicts are unresolved, before writing anything', async () => {
    await capture()
    await git('checkout', '-qb', 'other')
    await put('a.txt', 'other\n')
    await git('-c', 'commit.gpgsign=false', 'commit', '-qam', 'other')
    await git('checkout', '-q', 'main')
    await put('a.txt', 'main\n')
    await git('-c', 'commit.gpgsign=false', 'commit', '-qam', 'main')
    await runProcess({ program: 'git', args: ['merge', 'other'], cwd: dir })
    const conflicted = await read('a.txt')
    await expect(restore()).rejects.toMatchObject({ reason: 'merge-conflicts' })
    expect(await read('a.txt')).toBe(conflicted)
    expect(await git('for-each-ref', 'refs/orca/checkpoints/s1/undo/')).toBe('')
  })

  it('refuses when a folder now sits where the checkpoint has a file', async () => {
    await capture()
    await rm(join(dir, 'a.txt'))
    await put('a.txt/inside.log', 'ignored content\n')
    await expect(restore()).rejects.toMatchObject({ reason: 'blocked-path' })
    expect(await read('a.txt/inside.log')).toBe('ignored content\n')
  })

  it('works on an unborn branch', async () => {
    await rm(join(dir, '.git'), { recursive: true })
    await git('init', '-q')
    repo = await openCheckpointRepo(dir)
    await capture()
    await put('a.txt', 'agent\n')
    await put('fresh.txt', 'agent\n')
    await restore()
    expect(await read('a.txt')).toBe('a1\n')
    expect(existsSync(join(dir, 'fresh.txt'))).toBe(false)
  })

  it('prunes beyond the newest N and anything past the max age', async () => {
    for (let index = 0; index < 5; index += 1) {
      await capture(`refs/orca/checkpoints/s1/turn/t${index}`)
    }
    await capture('refs/orca/checkpoints/s2/turn/x')
    const deleted = await pruneCheckpointRefs(repo, {
      prefix: 'refs/orca/checkpoints/s1/turn/',
      keep: 3,
      maxAgeMs: 60_000,
      now: NOW
    })
    expect(deleted).toHaveLength(2)
    expect(await listCheckpointRefs(repo, 'refs/orca/checkpoints/s1/turn/')).toHaveLength(3)
    expect(await listCheckpointRefs(repo, 'refs/orca/checkpoints/s2/')).toHaveLength(1)
    await pruneCheckpointRefs(repo, {
      prefix: 'refs/orca/checkpoints/s1/turn/',
      keep: 50,
      maxAgeMs: -60_000,
      now: NOW
    })
    expect(await listCheckpointRefs(repo, 'refs/orca/checkpoints/')).toEqual([])
  })

  it('rejects plain folders', async () => {
    const plain = await mkdtemp(join(tmpdir(), 'orca-checkpoint-plain-'))
    try {
      await expect(openCheckpointRepo(plain)).rejects.toMatchObject({ reason: 'not-a-repo' })
    } finally {
      await rm(plain, { recursive: true, force: true })
    }
  })
})
