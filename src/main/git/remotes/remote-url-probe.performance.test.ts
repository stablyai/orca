import type * as FileSystem from 'node:fs/promises'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const { gitExecFileAsyncMock, headReadMock } = vi.hoisted(() => ({
  gitExecFileAsyncMock: vi.fn<(args: string[]) => Promise<{ stdout: string }>>(),
  headReadMock: vi.fn()
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof FileSystem>()
  return {
    ...fs,
    readFile: (...args: Parameters<typeof fs.readFile>) => {
      if (basename(String(args[0])) === 'HEAD') {
        headReadMock()
      }
      return fs.readFile(...args)
    }
  }
})

vi.mock('../command-runner/git-exec-file', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  gitExecFileAsync: gitExecFileAsyncMock
}))

import {
  _resetProjectRefCache,
  getProjectRefForRemoteWithSignature
} from '../../gitlab/projects/gitlab-project-ref-resolution'
import { readLocalGitConfigSignature } from '../../github/repositories/local-git-config-signature'
import { listCachedRemoteNames } from './remote-name-listing'
import { readRemoteUrl } from './remote-url-probe'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'remote-url-probe-perf-'))
  gitExecFileAsyncMock.mockReset()
  headReadMock.mockClear()
  _resetProjectRefCache()
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
it('answers warm reads for a missing origin without spawning Git', async () => {
  expect(await warmOriginReads(12, 4)).toEqual({ listings: 12, urlReads: 0 })
})

// An ordinary branch switch must preserve config-signed answers without rebuilding remote listings.
it('keeps a remote listing warm across an ordinary checkout', async () => {
  await mkdir(join(root, '.git'))
  await writeFile(join(root, '.git', 'config'), '[remote "upstream"]\n  url = /x\n')
  await writeFile(join(root, '.git', 'HEAD'), 'ref: refs/heads/first\n')
  await listCachedRemoteNames(root)

  await writeFile(join(root, '.git', 'HEAD'), 'ref: refs/heads/other\n')
  await listCachedRemoteNames(root)
  await expect(readRemoteUrl({ repoPath: root }, 'origin')).rejects.toThrow(/No such remote/)

  expect(gitExecFileAsyncMock.mock.calls.map(([args]) => args)).toEqual([['remote']])
})

it('reads HEAD once across conditional config fragments', async () => {
  await mkdir(join(root, '.git'))
  await writeFile(join(root, '.git', 'HEAD'), 'ref: refs/heads/first\n')
  const includes: string[] = []
  for (let index = 0; index < 10; index += 1) {
    const name = `fragment-${index}`
    includes.push(`[include] path = ${name}`)
    await writeFile(
      join(root, '.git', name),
      '[includeIf "onbranch:release/**"] path = remote-config\n'
    )
  }
  await writeFile(join(root, '.git', 'config'), includes.join('\n'))
  expect(await readLocalGitConfigSignature({ repoPath: root, connectionId: null })).toBeDefined()
  expect(headReadMock).toHaveBeenCalledTimes(1)
})

it('keeps listings warm across detached commits', async () => {
  await mkdir(join(root, '.git'))
  await writeFile(
    join(root, '.git', 'config'),
    '[includeIf "onbranch:release/**"] path = remote-config\n'
  )
  await writeFile(join(root, '.git', 'HEAD'), `${'a'.repeat(40)}\n`)
  await listCachedRemoteNames(root)
  for (let index = 0; index < 10; index += 1) {
    await writeFile(join(root, '.git', 'HEAD'), `${index.toString(16).padStart(40, '0')}\n`)
    await listCachedRemoteNames(root)
  }
  expect(
    gitExecFileAsyncMock.mock.calls.filter(([args]) => args.join(' ') === 'remote')
  ).toHaveLength(1)
  await writeFile(join(root, '.git', 'HEAD'), 'ref: refs/heads/release/next\n')
  await listCachedRemoteNames(root)
  expect(
    gitExecFileAsyncMock.mock.calls.filter(([args]) => args.join(' ') === 'remote')
  ).toHaveLength(2)
})

it('does not sign branch-dependent config with a reftable HEAD placeholder', async () => {
  await mkdir(join(root, '.git'))
  await writeFile(
    join(root, '.git', 'config'),
    '[includeIf "onbranch:release/**"] path = remote-config\n'
  )
  await writeFile(join(root, '.git', 'HEAD'), 'ref: refs/heads/.invalid\n')
  expect(await readLocalGitConfigSignature({ repoPath: root, connectionId: null })).toBeUndefined()
})

it('bounds unsigned project-ref probes and expires them', async () => {
  gitExecFileAsyncMock.mockResolvedValue({ stdout: 'https://gitlab.com/example/first.git\n' })
  const read = () => getProjectRefForRemoteWithSignature(Promise.resolve(undefined), root, 'origin')
  for (let index = 0; index < 10; index += 1) {
    expect(await read()).toEqual({ host: 'gitlab.com', path: 'example/first' })
  }
  expect(gitExecFileAsyncMock).toHaveBeenCalledTimes(1)
  gitExecFileAsyncMock.mockResolvedValue({ stdout: 'https://gitlab.com/example/next.git\n' })
  vi.setSystemTime(1_030_000)
  expect(await read()).toEqual({ host: 'gitlab.com', path: 'example/next' })
  expect(gitExecFileAsyncMock).toHaveBeenCalledTimes(2)
})
