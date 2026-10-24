import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { gitExecFileAsync } from '../../git/runner'
import { serveRepositoriesOverTestSsh } from '../__mocks__/plugin-git-ssh-remote-fixture'
import { fetchPluginMarketplace } from './plugin-marketplace-fetch'

const roots: string[] = []
afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

it('reads only the catalog index, prefers orca-catalog.json, and ignores plugin size limits', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orca-marketplace-fetch-'))
  roots.push(root)
  const repository = join(root, 'catalog')
  const git = async (args: string[]) => (await gitExecFileAsync(args, { cwd: repository })).stdout
  const entry = {
    id: 'samples.demo',
    source: { kind: 'git', url: 'https://example.com/demo.git', ref: 'v1' },
    categories: []
  }
  const catalog = (name: string, plugins: unknown[]) =>
    JSON.stringify({ name, owner: 'samples', plugins })
  // More files than one plugin may hold: the catalog download has its own limits.
  await mkdir(join(repository, 'packs'), { recursive: true })
  for (let index = 0; index <= 2_000; index += 1) {
    await writeFile(join(repository, 'packs', `${index}.txt`), String(index))
  }
  await writeFile(join(repository, 'orca-marketplace.json'), catalog('Old', [entry]))
  await writeFile(
    join(repository, 'orca-catalog.json'),
    JSON.stringify({ catalogVersion: 2, name: 'New', owner: 'samples', plugins: [] })
  )
  await git(['init', '--quiet'])
  await git(['add', '--all'])
  await git(['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'c'])
  await git(['tag', 'catalog'])
  await serveRepositoriesOverTestSsh(root, { '/catalog.git': repository })

  const fetched = await fetchPluginMarketplace({
    id: 'a'.repeat(32),
    source: { kind: 'git', url: 'ssh://git@catalog.example.invalid/catalog.git', ref: 'catalog' },
    addedAt: 0
  })

  expect(fetched.marketplace.name).toBe('New')
  expect(fetched.marketplaceCommit).toBe((await git(['rev-parse', 'HEAD'])).trim())
})
