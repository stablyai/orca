import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import { gitExecFileAsyncBuffer } from '../../git/command-runner/git-exec-file'
import { fetchPluginMarketplace } from './plugin-marketplace-fetch'

const repository = vi.hoisted(() => ({ path: '', commit: '' }))
vi.mock('../installation/plugin-git-repository', () => ({
  readPluginGitCommit: async <T>(
    _input: unknown,
    read: (path: string, commit: string) => Promise<T>
  ) => ({ commit: repository.commit, value: await read(repository.path, repository.commit) })
}))
const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

it.each([
  { url: 'https://github.com/acme/catalog.git', expected: 'missing.png' },
  { url: 'https://gitlab.com/acme/catalog.git', expected: undefined },
  { url: 'git@github.com:acme/catalog.git', expected: undefined }
])(
  'preserves unfetched image references only for the supported HTTPS source: $url',
  async ({ url, expected }) => {
    repository.path = await mkdtemp(join(tmpdir(), 'orca-catalog-source-'))
    roots.push(repository.path)
    const git = (args: string[]) =>
      gitExecFileAsyncBuffer(args, { cwd: repository.path, timeout: 10_000 })
    await writeFile(
      join(repository.path, 'orca-catalog.json'),
      JSON.stringify({
        catalogVersion: 2,
        name: 'Catalog',
        owner: 'acme',
        plugins: [
          {
            id: 'acme.picture',
            source: { kind: 'git', url: 'https://github.com/acme/picture.git', ref: 'main' },
            categories: ['themes'],
            releases: [
              {
                version: '1.0.0',
                minimumOrca: '1.4.0',
                execution: 'data',
                commit: 'a'.repeat(40),
                contentHash: 'b'.repeat(64),
                images: {
                  cover: {
                    path: 'missing.png',
                    alt: 'Picture',
                    sha256: 'c'.repeat(64),
                    width: 1600,
                    height: 1000
                  }
                }
              }
            ]
          }
        ]
      })
    )
    await git(['init', '--quiet'])
    await git(['add', '.'])
    await git([
      '-c',
      'user.name=Catalog test',
      '-c',
      'user.email=catalog@example.invalid',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '--quiet',
      '-m',
      'catalog fixture'
    ])
    repository.commit = (await git(['rev-parse', 'HEAD'])).stdout.toString().trim()
    const refresh = async <T>(
      _source: unknown,
      read: (path: string, commit: string) => Promise<T>
    ) => ({ commit: repository.commit, value: await read(repository.path, repository.commit) })

    const result = await fetchPluginMarketplace(
      { id: 'a'.repeat(32), addedAt: 0, source: { kind: 'git', url, ref: 'main' } },
      { repositories: { refresh } }
    )

    expect(result.marketplace.plugins[0]?.releases?.[0]?.images?.cover?.path).toBe(expected)
  }
)
