import type { ChildProcess, SpawnOptions } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  completeFakeSpawn,
  createFakeSpawnedChild
} from '../../shared/__fixtures__/fake-spawned-child'
import type { GhExecOptions } from '../git/command-runner/gh-exec-file'

const { spawnMock, boundEnvMock } = vi.hoisted(() => ({
  spawnMock:
    vi.fn<(program: string, args: readonly string[], options: SpawnOptions) => ChildProcess>(),
  boundEnvMock: vi.fn<(options: GhExecOptions) => Promise<NodeJS.ProcessEnv>>()
}))
vi.mock('node:child_process', async (original) => ({ ...(await original()), spawn: spawnMock }))
vi.mock('../git/command-runner/gh-bound-account-env', async (original) => ({
  ...(await original()),
  resolveBoundGhExecEnv: boundEnvMock
}))

import { ghExecFileAsync } from '../git/command-runner/gh-exec-file'
import { ghRepoExecOptions, githubRepoContext } from '../github/github-repository-identity'
import { resolveHostedReviewGitHubOptions } from '../source-control/hosted-review-git-options'
import { GitHubParticipantRegistry } from './github-participant-registry'
import {
  getRuntimeGitHubExecutionOptionArgs,
  getRuntimeHostedReviewExecutionOptions
} from './runtime-github-execution-options'
import { partialRuntimeStore, storeRepo } from './runtime-store-partial-fixture'
import { runWithActiveRpcCaller } from './rpc/rpc-active-caller'

const directories: string[] = []
const aliceAccount = { host: 'github.com', user: 'alice' }
const bobAccount = { host: 'github.com', user: 'bob' }

beforeEach(() => {
  vi.useFakeTimers()
  spawnMock.mockReset()
  boundEnvMock.mockReset().mockImplementation(async (options) => ({
    ORCA_TEST_GH_ACCOUNT: options.ghAccount?.user
  }))
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function fixture(route: 'direct' | 'hosted-review' | 'ssh-repository') {
  const directory = mkdtempSync(join(tmpdir(), 'orca-member-gh-retry-'))
  directories.push(directory)
  const registry = new GitHubParticipantRegistry(directory, () => ({}))
  const participant = registry.createParticipant({
    name: 'Alice',
    deviceIds: ['alice-device'],
    allowedAccounts: [aliceAccount, bobAccount]
  })
  const repo = storeRepo({ id: 'repo', path: directory })
  registry.setRepoEnabled(repo.id, true)
  registry.selectAccount(repo.id, 'alice-device', aliceAccount)
  const store = partialRuntimeStore()
  const options = runWithActiveRpcCaller(
    { kind: 'paired-device', deviceId: 'alice-device' },
    () => {
      const local =
        route === 'hosted-review'
          ? getRuntimeHostedReviewExecutionOptions(store, registry, repo)?.localGitExecOptions
          : getRuntimeGitHubExecutionOptionArgs(store, registry, repo)[0]
      return ghRepoExecOptions(
        githubRepoContext(repo.path, route === 'ssh-repository' ? 'ssh-connection' : null, local)
      )
    }
  )
  return { registry, participant, options }
}

function transientThenSuccess(): void {
  spawnMock.mockImplementation((_program, _args, options) => {
    const child = createFakeSpawnedChild()
    const first = spawnMock.mock.calls.length === 1
    queueMicrotask(() =>
      completeFakeSpawn(
        child,
        first
          ? { code: 1, stderr: 'HTTP 503 Service Unavailable' }
          : { stdout: JSON.stringify({ login: options.env?.ORCA_TEST_GH_ACCOUNT }) }
      )
    )
    return child
  })
}

it.each(['direct', 'hosted-review', 'ssh-repository'] as const)(
  'refuses another external attempt when a member grant is revoked during backoff (%s)',
  async (route) => {
    const { registry, participant, options } = fixture(route)
    transientThenSuccess()
    const outcome = ghExecFileAsync(['api', 'user'], options).then(
      () => 'unexpected success',
      (error: unknown) => (error instanceof Error ? error.message : String(error))
    )
    await vi.advanceTimersByTimeAsync(0)
    expect(spawnMock).toHaveBeenCalledOnce()
    registry.updateParticipant(participant.id, { allowedAccounts: [bobAccount] })
    await vi.advanceTimersByTimeAsync(250)
    await expect(outcome).resolves.toBe('github_participant_account_not_allowed')
    expect(spawnMock).toHaveBeenCalledOnce()
  }
)

it('keeps the accepted account on retry when only the member selection changes', async () => {
  const { registry, options } = fixture('direct')
  transientThenSuccess()
  const result = ghExecFileAsync(['api', 'user'], options)
  await vi.advanceTimersByTimeAsync(0)
  registry.selectAccount('repo', 'alice-device', bobAccount)
  await vi.advanceTimersByTimeAsync(250)
  await expect(result).resolves.toMatchObject({ stdout: JSON.stringify({ login: 'alice' }) })
  expect(spawnMock).toHaveBeenCalledTimes(2)
})

it('checks authorization again after credentials resolve before spawning an API command', async () => {
  const { registry, participant, options } = fixture('direct')
  const credentials = Promise.withResolvers<NodeJS.ProcessEnv>()
  boundEnvMock.mockReturnValueOnce(credentials.promise)
  transientThenSuccess()
  const outcome = ghExecFileAsync(['api', 'user'], options).then(
    () => 'unexpected success',
    (error: unknown) => (error instanceof Error ? error.message : String(error))
  )
  await vi.advanceTimersByTimeAsync(0)
  registry.updateParticipant(participant.id, { allowedAccounts: [bobAccount] })
  credentials.resolve({ ORCA_TEST_GH_ACCOUNT: 'alice' })
  await vi.advanceTimersByTimeAsync(1_250)
  await expect(outcome).resolves.toBe('github_participant_account_not_allowed')
  expect(spawnMock).not.toHaveBeenCalled()
})

it('preserves an existing eligibility refusal while resolving hosted-review accounts', async () => {
  const { options } = fixture('hosted-review')
  const ghOptions = resolveHostedReviewGitHubOptions({
    localGitExecOptions: {
      ...options,
      resolveGitHubAccount: () => aliceAccount,
      canStart: () => false
    }
  })
  await expect(ghExecFileAsync(['api', 'user'], ghOptions)).rejects.toMatchObject({
    name: 'AbortError'
  })
  expect(spawnMock).not.toHaveBeenCalled()
})
