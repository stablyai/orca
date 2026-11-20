import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { gitExecFileAsyncMock } = vi.hoisted(() => ({
  gitExecFileAsyncMock: vi.fn<(args: string[]) => Promise<{ stdout: string }>>()
}))

vi.mock('../command-runner/git-exec-file', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  gitExecFileAsync: gitExecFileAsyncMock
}))

import { listCachedRemoteNames } from './remote-name-listing'
import { readRemoteUrl } from './remote-url-probe'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'remote-url-probe-perf-'))
  gitExecFileAsyncMock.mockReset()
  gitExecFileAsyncMock.mockImplementation(async (args: string[]) => {
    if (args[0] === 'remote' && args[1] === 'get-url') {
      throw new Error(`error: No such remote '${args[2]}'`)
    }
    // Every repo has a remote, just not origin.
    return { stdout: 'upstream\n' }
  })
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(1_000_000)
})

afterEach(async () => {
  vi.useRealTimers()
  await rm(root, { recursive: true, force: true })
})

/** Signs listings for `repos` repos without origin, then reads origin from each once a minute. */
async function warmOriginReads(repos: number, rounds: number) {
  const paths: string[] = []
  for (let index = 0; index < repos; index += 1) {
    const repoPath = join(root, `repo-${repos}-${index}`)
    await mkdir(join(repoPath, '.git'), { recursive: true })
    await writeFile(join(repoPath, '.git', 'config'), '[remote "upstream"]\n\turl = /x\n')
    paths.push(repoPath)
    await listCachedRemoteNames(repoPath)
  }
  for (let round = 0; round < rounds; round += 1) {
    vi.setSystemTime(1_000_000 + (round + 1) * 60_000)
    for (const repoPath of paths) {
      await expect(readRemoteUrl({ repoPath }, 'origin')).rejects.toThrow(/No such remote/)
    }
  }
  const calls = gitExecFileAsyncMock.mock.calls.map(([args]) => args.join(' '))
  return {
    listings: calls.filter((call) => call === 'remote').length,
    urlReads: calls.filter((call) => call.startsWith('remote get-url')).length
  }
}

// Guards #44704's perf review: a warm refresh of a repo without origin re-spawned `git remote get-url`
// through the GitHub fallback once the per-remote missing cache was gone.
describe('origin reads on repos without origin', () => {
  it.each([
    [12, { listings: 12, urlReads: 0 }],
    [120, { listings: 120, urlReads: 0 }]
  ])('answer from the signed listing without spawning Git (N=%i)', async (repos, children) => {
    expect(await warmOriginReads(repos, 4)).toEqual(children)
  })
})
