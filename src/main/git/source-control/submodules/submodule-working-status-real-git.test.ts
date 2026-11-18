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

async function runGit(root: string, cwd: string, ...args: string[]): Promise<string> {
  const result = await runProcess({
    program: 'git',
    args,
    cwd,
    timeoutMs: 10_000,
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: join(root, 'missing-config'),
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.test',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.test'
    }
  })
  expect(result.code, result.stderr).toBe(0)
  return result.stdout
}

async function initRepo(root: string, repo: string): Promise<void> {
  await mkdir(repo)
  await runGit(root, repo, 'init', '-q')
  await runGit(root, repo, 'config', 'commit.gpgsign', 'false')
}

describe('getSubmoduleStatus working-tree mode with real Git', () => {
  it('returns only the working-tree edit without line stats when a submodule is also one commit ahead', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-submodule-working-status-'))
    directories.push(root)
    const source = join(root, 'source')
    const parent = join(root, 'parent')
    const sub = join(parent, 'sub')

    await initRepo(root, source)
    await writeFile(join(source, 'committed.txt'), 'v1\n')
    await writeFile(join(source, 'edited.txt'), 'base\n')
    await runGit(root, source, 'add', '.')
    await runGit(root, source, 'commit', '-qm', 'recorded')

    await initRepo(root, parent)
    await runGit(root, parent, 'clone', '-q', source, 'sub')
    await runGit(root, parent, 'config', '--file', '.gitmodules', 'submodule.sub.path', 'sub')
    await runGit(root, parent, 'config', '--file', '.gitmodules', 'submodule.sub.url', source)
    await runGit(root, parent, 'add', '.')
    await runGit(root, parent, 'commit', '-qm', 'parent')

    await runGit(root, sub, 'config', 'commit.gpgsign', 'false')
    await writeFile(join(sub, 'committed.txt'), 'v2\n')
    await runGit(root, sub, 'add', 'committed.txt')
    await runGit(root, sub, 'commit', '-qm', 'ahead')
    await writeFile(join(sub, 'edited.txt'), 'dirty\n')

    const workingStatus = await getSubmoduleStatus(parent, 'sub', { workingTreeOnly: true })
    expect(workingStatus.entries).toEqual([
      {
        path: 'edited.txt',
        status: 'modified',
        area: 'unstaged'
      }
    ])

    const sourceControlStatus = await getSubmoduleStatus(parent, 'sub')
    expect(sourceControlStatus.entries.map((entry) => entry.path)).toEqual([
      'committed.txt',
      'edited.txt'
    ])
  })

  it('skips an uninitialized submodule directory instead of walking up to the parent repo', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-submodule-uninitialized-'))
    directories.push(root)
    const source = join(root, 'source')
    const originParent = join(root, 'origin-parent')
    const cloneParent = join(root, 'clone-parent')

    await initRepo(root, source)
    await writeFile(join(source, 'inner.txt'), 'v1\n')
    await runGit(root, source, 'add', '.')
    await runGit(root, source, 'commit', '-qm', 'initial')

    await initRepo(root, originParent)
    await runGit(root, originParent, 'clone', '-q', source, 'sub')
    await runGit(root, originParent, 'config', '--file', '.gitmodules', 'submodule.sub.path', 'sub')
    await runGit(root, originParent, 'config', '--file', '.gitmodules', 'submodule.sub.url', source)
    await writeFile(join(originParent, 'parent.txt'), 'clean\n')
    await runGit(root, originParent, 'add', '.')
    await runGit(root, originParent, 'commit', '-qm', 'parent')

    // Cloning without --recurse-submodules leaves `sub/` as an empty uninitialized directory.
    await runGit(root, root, 'clone', '-q', originParent, cloneParent)
    await writeFile(join(cloneParent, 'parent.txt'), 'dirty\n')

    expect(await getSubmoduleStatus(cloneParent, 'sub', { workingTreeOnly: true })).toEqual({
      entries: [],
      conflictOperation: 'unknown'
    })
  })
})
