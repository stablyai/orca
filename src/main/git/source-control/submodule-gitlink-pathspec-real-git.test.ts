import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runProcess } from '@orca/process-host'
import { afterEach, describe, expect, it } from 'vitest'
import { gitExecFileAsync } from '../runner'
import { getDiff } from './file-diff'
import { getSubmoduleStatus } from './submodule-status'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })))
})

describe('literal submodule gitlinks with real Git', () => {
  it.each([
    'ordinary',
    'module[12]',
    ...(process.platform === 'win32' ? [] : [':(literal)module'])
  ])('reads %j without selecting a neighboring submodule', async (submodulePath) => {
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
      await git(repo, 'config', 'core.hooksPath', '')
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
    await writeFile(join(neighborSource, 'neighbor.txt'), 'neighbor preserved\n')
    await git(neighborSource, 'add', '.')
    await git(neighborSource, 'commit', '-qm', 'unrelated history')
    await init(parent)
    expect((await gitExecFileAsync(['--version'], { cwd: parent })).stdout.trim()).toBe(
      (await git(parent, '--version')).trim()
    )
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
    const parentHead = await git(parent, 'rev-parse', 'HEAD')
    const childIndex = await readFile(join(child, '.git/index'))
    const neighborIndex = await readFile(join(parent, 'module1', '.git/index'))
    const parentIndex = await readFile(join(parent, '.git/index'))
    const pointer = {
      originalContent: `Subproject commit ${base}\n`,
      modifiedContent: `Subproject commit ${head}\n`
    }
    const content = { originalContent: 'target original\n', modifiedContent: 'target committed\n' }

    expect((await getSubmoduleStatus(parent, submodulePath)).entries).toContainEqual(
      expect.objectContaining({ path: 'file.txt', status: 'modified' })
    )
    expect(await getDiff(parent, submodulePath, false)).toMatchObject(pointer)
    expect(await getDiff(parent, `${submodulePath}/file.txt`, false)).toMatchObject(content)
    expect(await readFile(join(parent, '.git/index'))).toEqual(parentIndex)

    await git(parent, 'add', '--', `:(literal)${submodulePath}`)
    const stagedIndex = await readFile(join(parent, '.git/index'))
    expect(
      (await getSubmoduleStatus(parent, submodulePath, { staged: true })).entries
    ).toContainEqual(expect.objectContaining({ path: 'file.txt', status: 'modified' }))
    expect(await getDiff(parent, submodulePath, true)).toMatchObject(pointer)
    expect(await getDiff(parent, `${submodulePath}/file.txt`, true)).toMatchObject(content)
    expect(await readFile(join(parent, '.git/index'))).toEqual(stagedIndex)
    expect(await readFile(join(child, '.git/index'))).toEqual(childIndex)
    expect(await readFile(join(parent, 'module1', '.git/index'))).toEqual(neighborIndex)
    expect(await readFile(join(parent, 'module1', 'neighbor.txt'), 'utf8')).toBe(
      'neighbor preserved\n'
    )
    expect(await git(parent, 'rev-parse', 'HEAD')).toBe(parentHead)
    expect((await git(child, 'rev-parse', 'HEAD')).trim()).toBe(head)
  })
})
