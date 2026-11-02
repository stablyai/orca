import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runProcess } from '@orca/process-host'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { canDiscardStatusEntry } from '../../../shared/source-control-entry-actions'
import { discardChanges } from './discard-changes'
import { getStatus } from './status-read'

const directories: string[] = []

afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })))
})

describe('submodule discard eligibility with real Git', () => {
  it('offers discard for a dirty submodule only when submodule.recurse makes restore work', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-submodule-recurse-'))
    directories.push(root)
    vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1')
    vi.stubEnv('GIT_CONFIG_GLOBAL', join(root, 'missing-config'))
    const source = join(root, 'source')
    const parent = join(root, 'parent')
    const git = async (cwd: string, ...args: string[]) => {
      const result = await runProcess({ program: 'git', args, cwd, timeoutMs: 10_000 })
      expect(result.code, result.stderr).toBe(0)
    }
    const init = async (repo: string) => {
      await mkdir(repo)
      await git(repo, 'init', '-q')
      await git(repo, 'config', 'user.name', 'Test')
      await git(repo, 'config', 'user.email', 'test@example.test')
      await git(repo, 'config', 'commit.gpgsign', 'false')
    }
    await init(source)
    await writeFile(join(source, 'file.txt'), 'original\n')
    await git(source, 'add', '.')
    await git(source, 'commit', '-qm', 'base')
    await init(parent)
    await git(parent, 'clone', '-q', source, 'sub')
    await git(parent, 'config', '--file', '.gitmodules', 'submodule.sub.path', 'sub')
    await git(parent, 'config', '--file', '.gitmodules', 'submodule.sub.url', source)
    await git(parent, 'add', '.')
    await git(parent, 'commit', '-qm', 'parent')
    await git(parent, 'submodule', 'init', '-q')
    await writeFile(join(parent, 'sub', 'file.txt'), 'dirty\n')

    const subEntry = async () =>
      (await getStatus(parent, { includeLineStats: false })).entries.find(
        (entry) => entry.path === 'sub'
      )
    const plain = await subEntry()
    expect(plain?.submodule).toBeDefined()
    expect(plain && canDiscardStatusEntry(plain)).toBe(false)

    await git(parent, 'config', 'submodule.recurse', 'true')
    const recursing = await subEntry()
    expect(recursing && canDiscardStatusEntry(recursing)).toBe(true)

    await discardChanges(parent, 'sub')
    expect(await subEntry()).toBeUndefined()
  })
})
