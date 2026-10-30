import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runProcess } from '@orca/process-host'
import { afterEach, describe, expect, it } from 'vitest'
import { getDiff } from './file-diff'
import { getSubmoduleStatus } from './submodule-status'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })))
})

describe('literal submodule gitlinks with real Git', () => {
  it('reads a glob-like submodule path without selecting a matching neighbor', async () => {
    const submodulePath = 'module[12]'
    const root = await mkdtemp(join(tmpdir(), 'orca-gitlink-pathspec-'))
    directories.push(root)
    const source = join(root, 'source')
    const neighborSource = join(root, 'neighbor-source')
    const parent = join(root, 'parent')
    const child = join(parent, submodulePath)
    const git = async (cwd: string, ...args: string[]) => {
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
    const init = async (repo: string) => {
      await mkdir(repo)
      await git(repo, 'init', '-q')
      await git(repo, 'config', 'user.name', 'Test')
      await git(repo, 'config', 'user.email', 'test@example.test')
      await git(repo, 'config', 'commit.gpgsign', 'false')
    }
    await init(source)
    await writeFile(join(source, 'file.txt'), 'target original\n')
    await git(source, 'add', '.')
    await git(source, 'commit', '-qm', 'base')
    const base = (await git(source, 'rev-parse', 'HEAD')).trim()
    await writeFile(join(source, 'file.txt'), 'target committed\n')
    await git(source, 'commit', '-qam', 'update')
    const head = (await git(source, 'rev-parse', 'HEAD')).trim()
    await init(neighborSource)
    await writeFile(join(neighborSource, 'neighbor.txt'), 'neighbor\n')
    await git(neighborSource, 'add', '.')
    await git(neighborSource, 'commit', '-qm', 'unrelated history')
    await init(parent)
    await git(parent, 'clone', '-q', source, submodulePath)
    await git(parent, 'clone', '-q', neighborSource, 'module1')
    await git(child, 'checkout', '-q', base)
    await git(parent, 'config', '--file', '.gitmodules', 'submodule.target.path', submodulePath)
    await git(parent, 'config', '--file', '.gitmodules', 'submodule.target.url', source)
    await git(parent, 'config', '--file', '.gitmodules', 'submodule.neighbor.path', 'module1')
    await git(parent, 'config', '--file', '.gitmodules', 'submodule.neighbor.url', neighborSource)
    await git(parent, 'add', '.')
    await git(parent, 'commit', '-qm', 'parent')
    await git(child, 'checkout', '-q', head)

    expect((await getSubmoduleStatus(parent, submodulePath)).entries).toContainEqual(
      expect.objectContaining({ path: 'file.txt', status: 'modified' })
    )
    expect(await getDiff(parent, submodulePath, false)).toMatchObject({
      originalContent: `Subproject commit ${base}\n`,
      modifiedContent: `Subproject commit ${head}\n`
    })
    expect(await getDiff(parent, `${submodulePath}/file.txt`, false)).toMatchObject({
      originalContent: 'target original\n',
      modifiedContent: 'target committed\n'
    })
  })
})
