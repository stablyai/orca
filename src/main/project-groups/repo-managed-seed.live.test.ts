import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { seedDerivedRepoProjectGitDirs } from './repo-managed-derive'

const execFileAsync = promisify(execFile)

let tempDirs: string[] = []

async function tempRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'orca-repo-seed-live-'))
  tempDirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })))
  tempDirs = []
})

describe('seedDerivedRepoProjectGitDirs live git', () => {
  it('publishes local heads as origin refs so repo can checkout revision main', async () => {
    const root = await tempRoot()
    const mainPath = join(root, 'main')
    const destPath = join(root, 'task-a')
    const worktree = join(mainPath, 'bionic')
    await mkdir(worktree, { recursive: true })
    await mkdir(join(mainPath, '.repo'), { recursive: true })
    await writeFile(join(mainPath, '.repo', 'project.list'), 'bionic\n')
    await writeFile(join(worktree, 'README.md'), 'bionic\n')
    await execFileAsync('git', ['init', '-b', 'main'], { cwd: worktree })
    await execFileAsync(
      'git',
      ['-c', 'user.email=demo@example.com', '-c', 'user.name=Demo', 'add', 'README.md'],
      {
        cwd: worktree
      }
    )
    await execFileAsync(
      'git',
      ['-c', 'user.email=demo@example.com', '-c', 'user.name=Demo', 'commit', '-m', 'init'],
      { cwd: worktree }
    )
    await mkdir(destPath, { recursive: true })

    await seedDerivedRepoProjectGitDirs({ mainPath, destPath })

    const destGit = join(destPath, '.repo', 'projects', 'bionic.git')
    const { stdout } = await execFileAsync('git', ['--git-dir', destGit, 'show-ref'])
    expect(stdout).toMatch(/refs\/heads\/main/)
    expect(stdout).toMatch(/refs\/remotes\/origin\/main/)
    const { stdout: objectType } = await execFileAsync('git', [
      '--git-dir',
      destGit,
      'cat-file',
      '-t',
      'refs/remotes/origin/main'
    ])
    expect(objectType.trim()).toBe('commit')
    const { stdout: bare } = await execFileAsync('git', [
      '--git-dir',
      destGit,
      'config',
      '--get',
      'core.bare'
    ])
    expect(bare.trim()).toBe('false')
    const { stdout: fetch } = await execFileAsync('git', [
      '--git-dir',
      destGit,
      'config',
      '--get',
      'remote.origin.fetch'
    ])
    expect(fetch.trim()).toBe('+refs/heads/*:refs/remotes/origin/*')
  })

  it('seeds from a gitfile worktree whose objects live in .repo/projects', async () => {
    const root = await tempRoot()
    const mainPath = join(root, 'main')
    const destPath = join(root, 'task-a')
    const worktree = join(mainPath, 'frameworks', 'base')
    const farm = join(mainPath, '.repo', 'projects', 'frameworks', 'base.git')
    await mkdir(worktree, { recursive: true })
    await writeFile(join(worktree, 'README.md'), 'frameworks/base\n')
    await execFileAsync('git', ['init', '-b', 'main'], { cwd: worktree })
    await execFileAsync(
      'git',
      ['-c', 'user.email=demo@example.com', '-c', 'user.name=Demo', 'add', 'README.md'],
      { cwd: worktree }
    )
    await execFileAsync(
      'git',
      ['-c', 'user.email=demo@example.com', '-c', 'user.name=Demo', 'commit', '-m', 'init'],
      { cwd: worktree }
    )
    await mkdir(join(farm, '..'), { recursive: true })
    await execFileAsync('git', ['clone', '--bare', worktree, farm])
    await rm(join(worktree, '.git'), { recursive: true, force: true })
    await writeFile(join(worktree, '.git'), 'gitdir: ../../.repo/projects/frameworks/base.git\n')
    await mkdir(join(mainPath, '.repo'), { recursive: true })
    await writeFile(join(mainPath, '.repo', 'project.list'), 'frameworks/base\n')
    await mkdir(destPath, { recursive: true })

    await seedDerivedRepoProjectGitDirs({ mainPath, destPath })

    const destGit = join(destPath, '.repo', 'projects', 'frameworks', 'base.git')
    const { stdout } = await execFileAsync('git', ['--git-dir', destGit, 'show-ref'])
    expect(stdout).toMatch(/refs\/remotes\/origin\/main/)
    const { stdout: objectType } = await execFileAsync('git', [
      '--git-dir',
      destGit,
      'cat-file',
      '-t',
      'refs/remotes/origin/main'
    ])
    expect(objectType.trim()).toBe('commit')
    const { stdout: fetch } = await execFileAsync('git', [
      '--git-dir',
      destGit,
      'config',
      '--get',
      'remote.origin.fetch'
    ])
    expect(fetch.trim()).toBe('+refs/heads/*:refs/remotes/origin/*')
  })
})
