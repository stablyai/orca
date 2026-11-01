import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { serveRepositoriesOverTestSsh } from '../__mocks__/plugin-git-ssh-remote-fixture'
import { runPluginGit } from './plugin-git-repository'
import { resolvePluginGitSource } from './plugin-git-ref-resolution'

const URL = 'ssh://git@plugins.example.invalid/sample.git'
const roots: string[] = []

afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'orca-plugin-ls-remote-test-'))
  roots.push(root)
  const repository = join(root, 'source')
  const config = join(root, 'config')
  await writeFile(config, '')
  vi.stubEnv('GIT_CONFIG_GLOBAL', config)
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1')
  await serveRepositoriesOverTestSsh(root, { '/sample.git': repository })
  await runPluginGit(['init', '--quiet', '--template=', repository], root)
  const git = (args: string[]) => runPluginGit(args, repository)
  await git(['config', 'user.name', 'Plugin fixture'])
  await git(['config', 'user.email', 'plugins@example.invalid'])
  const commit = async (message: string): Promise<string> => {
    await writeFile(join(repository, 'file.txt'), message)
    await git(['add', '--all'])
    await git(['commit', '--quiet', '-m', message])
    return git(['rev-parse', 'HEAD'])
  }
  return { git, commit }
}

it('pins a plain repository URL to its newest version tag, then the default branch', async () => {
  const f = await fixture()
  const first = await f.commit('first')
  const head = await f.commit('second')
  expect(await resolvePluginGitSource({ url: URL, ref: '' })).toEqual({
    ok: true,
    url: URL,
    kind: 'default-branch',
    ref: head,
    commit: head
  })
  await f.git(['tag', '-a', '-m', 'release', 'v0.1.0', first])
  expect(await resolvePluginGitSource({ url: URL, ref: '' })).toMatchObject({
    ok: true,
    kind: 'latest-tag',
    ref: 'v0.1.0',
    commit: first
  })
  expect(await resolvePluginGitSource({ url: URL, ref: 'readme' })).toEqual({
    ok: false,
    reason: 'ref-not-found',
    ref: 'readme'
  })
})

it('reports an unreachable repository without throwing', async () => {
  await fixture()
  const missing = await resolvePluginGitSource({
    url: 'ssh://git@plugins.example.invalid/missing.git',
    ref: ''
  })
  expect(missing).toMatchObject({ ok: false, reason: 'unreachable' })
})
