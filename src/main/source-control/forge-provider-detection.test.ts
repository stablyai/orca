import { execFileSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type * as GitExecFile from '../git/command-runner/git-exec-file'
import { gitExecFileAsync } from '../git/command-runner/git-exec-file'
import { getForgeProviderForRepository } from './forge-provider-detection'

vi.mock('../git/command-runner/git-exec-file', async (importOriginal) => {
  const actual = await importOriginal<typeof GitExecFile>()
  return { ...actual, gitExecFileAsync: vi.fn(actual.gitExecFileAsync) }
})

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function remoteUrlReads(): number {
  return vi
    .mocked(gitExecFileAsync)
    .mock.calls.filter(([args]) => args[0] === 'remote' && args[1] === 'get-url').length
}

it('reads a repo remote once per forge detection and rereads it after the remote changes', async () => {
  const repoPath = await mkdtemp(join(tmpdir(), 'orca-forge-remote-reads-'))
  roots.push(repoPath)
  execFileSync('git', ['init', '--quiet'], { cwd: repoPath })
  vi.mocked(gitExecFileAsync).mockClear()

  await expect(
    getForgeProviderForRepository({ repoPath, executionHostId: 'local' })
  ).resolves.toBeNull()
  expect(remoteUrlReads()).toBe(1)

  execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/stablyai/orca.git'], {
    cwd: repoPath
  })
  vi.mocked(gitExecFileAsync).mockClear()
  const provider = await getForgeProviderForRepository({ repoPath, executionHostId: 'local' })
  expect(provider?.id).toBe('github')
  expect(remoteUrlReads()).toBe(1)
})
