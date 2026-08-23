import { execFile } from 'node:child_process'
import { access, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { materializeRepoManagedCheckout } from './repo-managed-derive'

const execFileAsync = promisify(execFile)

let tempDirs: string[] = []

async function tempRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'orca-repo-derive-live-'))
  tempDirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })))
  tempDirs = []
})

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function createGitProject(worktree: string, name: string): Promise<void> {
  await mkdir(worktree, { recursive: true })
  await writeFile(join(worktree, 'README.md'), `${name}\n`)
  await execFileAsync('git', ['init', '-b', 'main'], { cwd: worktree })
  await execFileAsync(
    'git',
    ['-c', 'user.email=demo@example.com', '-c', 'user.name=Demo', 'add', 'README.md'],
    { cwd: worktree }
  )
  await execFileAsync(
    'git',
    ['-c', 'user.email=demo@example.com', '-c', 'user.name=Demo', 'commit', '-m', `init ${name}`],
    { cwd: worktree }
  )
}

describe('materializeRepoManagedCheckout live repo', () => {
  it('derives an isolated checkout from a gitfile-backed local tree', async () => {
    const repoBin = join(homedir(), '.orca', 'bin', 'repo')
    if (!(await pathExists(repoBin))) {
      return
    }
    const root = await tempRoot()
    const mainPath = join(root, 'main')
    const destPath = join(root, 'task-a')
    const bionic = join(mainPath, 'bionic')
    await createGitProject(bionic, 'bionic')
    const farm = join(mainPath, '.repo', 'projects', 'bionic.git')
    await mkdir(join(farm, '..'), { recursive: true })
    await execFileAsync('git', ['clone', '--bare', bionic, farm])
    await rm(join(bionic, '.git'), { recursive: true, force: true })
    await writeFile(join(bionic, '.git'), 'gitdir: ../.repo/projects/bionic.git\n')

    await mkdir(join(mainPath, '.repo', 'manifests'), { recursive: true })
    const manifest = `<?xml version="1.0" encoding="UTF-8"?>
<manifest>
  <remote name="origin" fetch="." />
  <default revision="main" remote="origin" />
  <project path="bionic" name="platform/bionic" />
</manifest>
`
    await writeFile(join(mainPath, '.repo', 'manifests', 'default.xml'), manifest)
    await execFileAsync('git', ['init', '-b', 'main'], {
      cwd: join(mainPath, '.repo', 'manifests')
    })
    await execFileAsync('git', ['add', 'default.xml'], {
      cwd: join(mainPath, '.repo', 'manifests')
    })
    await execFileAsync(
      'git',
      ['-c', 'user.email=demo@example.com', '-c', 'user.name=Demo', 'commit', '-m', 'manifest'],
      { cwd: join(mainPath, '.repo', 'manifests') }
    )
    await execFileAsync('git', [
      'clone',
      '--bare',
      join(mainPath, '.repo', 'manifests'),
      join(mainPath, '.repo', 'manifests.git')
    ])
    await symlink('manifests/default.xml', join(mainPath, '.repo', 'manifest.xml'))
    await writeFile(join(mainPath, '.repo', 'project.list'), 'bionic\n')

    const phases: string[] = []
    await materializeRepoManagedCheckout({
      mainPath,
      destPath,
      onPhase: (phase) => {
        phases.push(phase)
      }
    })

    expect(phases).toEqual(['preparing', 'init', 'seed', 'sync'])
    await expect(access(join(destPath, 'bionic', 'README.md'))).resolves.toBeUndefined()
    const { stdout } = await execFileAsync('git', [
      '--git-dir',
      join(destPath, '.repo', 'projects', 'bionic.git'),
      'cat-file',
      '-t',
      'refs/remotes/origin/main'
    ])
    expect(stdout.trim()).toBe('commit')
  }, 120_000)
})
