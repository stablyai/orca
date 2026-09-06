import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runGitFixture } from '../../shared/git-process-test-fixture'
import { readGitBlobAtOidPath } from './source-control/git-blob-read'

const tempRoots: string[] = []

async function createCommittedBareRepo(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'orca-bare-blob-read-'))
  const sourcePath = path.join(root, 'source')
  const barePath = path.join(root, 'repo.git')
  tempRoots.push(root)
  await mkdir(sourcePath)
  await runGitFixture(sourcePath, ['init', '--quiet'])
  await writeFile(path.join(sourcePath, 'file.txt'), 'committed content\n')
  await runGitFixture(sourcePath, ['add', 'file.txt'])
  await runGitFixture(sourcePath, [
    '-c',
    'user.email=test@example.com',
    '-c',
    'user.name=Test User',
    'commit',
    '--quiet',
    '-m',
    'initial'
  ])
  await runGitFixture(root, ['clone', '--bare', '--quiet', sourcePath, barePath])
  return realpath(barePath)
}

afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('Git blob reads from strict bare repositories', () => {
  it('reads committed content through an explicit gitdir retry', async () => {
    const barePath = await createCommittedBareRepo()
    vi.stubEnv('GIT_CONFIG_COUNT', '1')
    vi.stubEnv('GIT_CONFIG_KEY_0', 'safe.bareRepository')
    vi.stubEnv('GIT_CONFIG_VALUE_0', 'explicit')

    const result = await readGitBlobAtOidPath(barePath, 'HEAD', 'file.txt')

    expect(result).toEqual({
      content: 'committed content\n',
      isBinary: false,
      exists: true
    })
  })
})
