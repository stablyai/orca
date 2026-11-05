import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runProcess } from '@orca/process-host'
import { afterEach, expect, it, vi } from 'vitest'
import { getSubmoduleStatus } from './submodule-status'

let root: string | undefined

afterEach(async () => {
  vi.unstubAllEnvs()
  if (root) {
    await rm(root, { recursive: true, force: true })
  }
})

it('reports an unreadable staged submodule commit range instead of a clean result', async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-submodule-status-read-error-'))
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1')
  vi.stubEnv('GIT_CONFIG_GLOBAL', join(root, 'missing-config'))
  const parent = join(root, 'parent')
  const child = join(parent, 'sub')
  const git = async (cwd: string, ...args: string[]) => {
    const result = await runProcess({ program: 'git', args, cwd, timeoutMs: 10_000 })
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
  await init(parent)
  await init(child)
  await writeFile(join(child, 'file.txt'), 'original\n')
  await git(child, 'add', 'file.txt')
  await git(child, 'commit', '-qm', 'child base')
  const childHead = (await git(child, 'rev-parse', 'HEAD')).trim()
  await git(parent, 'config', '--file', '.gitmodules', 'submodule.sub.path', 'sub')
  await git(parent, 'config', '--file', '.gitmodules', 'submodule.sub.url', './sub')
  await git(parent, 'add', '.gitmodules')
  await git(parent, 'update-index', '--add', '--cacheinfo', '160000', childHead, 'sub')
  await git(parent, 'commit', '-qm', 'parent base')
  await git(
    parent,
    'update-index',
    '--cacheinfo',
    '160000',
    '0123456789012345678901234567890123456789',
    'sub'
  )

  const result = await getSubmoduleStatus(parent, 'sub', { staged: true })

  expect(result.entries).toEqual([])
  expect(result.readError).toContain('0123456789012345678901234567890123456789')
})
