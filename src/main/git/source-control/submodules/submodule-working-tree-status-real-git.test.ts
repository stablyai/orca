import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runProcess } from '@orca/process-host'
import { afterEach, describe, expect, it } from 'vitest'
import { getSubmoduleStatus } from './submodule-status'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })))
})

async function createRepos(): Promise<{
  git: (cwd: string, ...args: string[]) => Promise<string>
  source: string
  parent: string
}> {
  const root = await mkdtemp(join(tmpdir(), 'orca-submodule-working-'))
  directories.push(root)
  const git = async (cwd: string, ...args: string[]): Promise<string> => {
    const result = await runProcess({
      program: 'git',
      args,
      cwd,
      timeoutMs: 10_000,
      env: {
        ...process.env,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: join(root, 'missing-config')
      }
    })
    expect(result.code, result.stderr).toBe(0)
    return result.stdout
  }
  const init = async (repo: string): Promise<void> => {
    await mkdir(repo)
    await git(repo, 'init', '-q')
    await git(repo, 'config', 'user.name', 'Test')
    await git(repo, 'config', 'user.email', 'test@example.test')
    await git(repo, 'config', 'commit.gpgsign', 'false')
    await git(repo, 'config', 'core.autocrlf', 'false')
  }
  const source = join(root, 'source')
  const parent = join(root, 'parent')
  await init(source)
  await writeFile(join(source, 'edited.txt'), 'original\n')
  await writeFile(join(source, 'committed.txt'), 'original\n')
  await git(source, 'add', '.')
  await git(source, 'commit', '-qm', 'base')
  await init(parent)
  return { git, source, parent }
}

describe('submodule working-tree status with real Git', () => {
  it('returns only the edited file for a submodule one commit ahead of its gitlink', async () => {
    const { git, source, parent } = await createRepos()
    await git(parent, 'clone', '-q', source, 'mod')
    await git(parent, 'config', '--file', '.gitmodules', 'submodule.mod.path', 'mod')
    await git(parent, 'config', '--file', '.gitmodules', 'submodule.mod.url', source)
    await git(parent, 'add', '.')
    await git(parent, 'commit', '-qm', 'parent')
    const child = join(parent, 'mod')
    await git(child, 'config', 'user.name', 'Test')
    await git(child, 'config', 'user.email', 'test@example.test')
    await writeFile(join(child, 'committed.txt'), 'committed in the submodule\n')
    await git(child, 'commit', '-qam', 'ahead of the gitlink')
    await writeFile(join(child, 'edited.txt'), 'edited\n')

    const working = await getSubmoduleStatus(parent, 'mod', { workingTreeOnly: true })

    expect(working.entries.map((entry) => [entry.path, entry.status])).toEqual([
      ['edited.txt', 'modified']
    ])
  })

  it('returns no entries for a submodule folder that is not checked out', async () => {
    const { git, parent } = await createRepos()
    await writeFile(join(parent, 'parent-file.txt'), 'untracked in the parent\n')
    await mkdir(join(parent, 'mod'))
    await git(parent, 'add', 'parent-file.txt')

    const working = await getSubmoduleStatus(parent, 'mod', { workingTreeOnly: true })

    expect(working.entries).toEqual([])
  })
})
