import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createFakeSpawnedChild } from '../../shared/__fixtures__/fake-spawned-child'
import type { Repo } from '../../shared/repo-types'

const { spawnMock, requestMock } = vi.hoisted(() => ({ spawnMock: vi.fn(), requestMock: vi.fn() }))

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal()),
  spawn: spawnMock
}))
vi.mock('./github-api-repository', () => ({
  getOriginGitHubApiRepository: vi.fn(async () => ({
    owner: 'acme',
    repo: 'widgets',
    host: 'github.com'
  })),
  githubHostExecOptions: () => ({ host: 'github.com' })
}))

import { _resetGhRateLimitBreaker } from '../git/gh-rate-limit-breaker'
import { installGitHubProjectAccounts } from './github-project-account'
import { createGitHubPullRequest } from './client/create/create-github-pull-request'
import { clearGhAccountTokenCacheForTests } from './gh-account-token'
import { clearGhCapabilityStateForTests } from './gh-capability-state'
import { runGraphql } from './project-view/internals'

let releaseAccounts: (() => void) | undefined
let repo: Repo
beforeEach(() => {
  _resetGhRateLimitBreaker()
  clearGhAccountTokenCacheForTests()
  clearGhCapabilityStateForTests()
  requestMock.mockReset()
  spawnMock.mockReset()
  spawnMock.mockImplementation((_command, args: string[], options: { env: NodeJS.ProcessEnv }) => {
    if (args[0] !== 'auth') {
      return requestMock(args, options)
    }
    const child = createFakeSpawnedChild()
    const output = args.includes('--help') ? '--user' : `${args[args.indexOf('--user') + 1]}-token`
    queueMicrotask(() => complete(child, output))
    return child
  })
  repo = {
    id: 'work',
    displayName: 'Work',
    path: '/work',
    badgeColor: '#000000',
    addedAt: 0,
    ghAccount: { host: 'github.com', user: 'Alice' }
  }
  releaseAccounts = installGitHubProjectAccounts({ getRepos: () => [repo] })
})
afterEach(() => {
  releaseAccounts?.()
  _resetGhRateLimitBreaker()
  vi.unstubAllEnvs()
})

function complete(child: ReturnType<typeof createFakeSpawnedChild>, stdout: string): void {
  child.stdout?.emit('data', Buffer.from(stdout))
  child.emit('exit', 0, null)
  child.emit('close', 0, null)
}

it('keeps Project View ambient even with a bound project cwd', async () => {
  vi.stubEnv('GH_TOKEN', 'personal-token')
  let selectedPersonal = false
  requestMock.mockImplementation((_args, options: { env: NodeJS.ProcessEnv }) => {
    selectedPersonal = options.env.GH_TOKEN === 'personal-token'
    const child = createFakeSpawnedChild()
    queueMicrotask(() => complete(child, '{"data":{"viewer":{"login":"personal"}}}'))
    return child
  })
  await expect(
    runGraphql('query { viewer { login } }', {}, { cwd: repo.path, host: 'github.com' })
  ).resolves.toMatchObject({ ok: true, data: { viewer: { login: 'personal' } } })
  expect(selectedPersonal).toBe(true)
  expect(spawnMock.mock.calls.some(([, args]) => args[0] === 'auth')).toBe(false)
})

it('keeps creation recovery on its original account while the next operation reads a rebind', async () => {
  const tokens: (string | undefined)[] = []
  let startCreate: (finish: () => void) => void = () => {}
  const started = new Promise<() => void>((resolve) => {
    startCreate = resolve
  })
  let firstCreate = true
  requestMock.mockImplementation((args: string[], options: { env: NodeJS.ProcessEnv }) => {
    tokens.push(options.env.GH_TOKEN)
    const child = createFakeSpawnedChild()
    if (args[0] === 'pr' && args[1] === 'create' && firstCreate) {
      firstCreate = false
      startCreate(() => complete(child, 'unconfirmed'))
    } else {
      queueMicrotask(() =>
        complete(
          child,
          JSON.stringify(
            args[1] === 'list'
              ? [{ number: 42, url: 'https://github.com/acme/widgets/pull/42' }]
              : { number: 43, url: 'https://github.com/acme/widgets/pull/43' }
          )
        )
      )
    }
    return child
  })
  const input = { provider: 'github', base: 'main', head: 'feature', title: 'Change' } as const
  const pending = createGitHubPullRequest(repo.path, input, 'local')
  const finish = await started
  repo = { ...repo, ghAccount: { host: 'github.com', user: 'Bob' } }
  finish()
  await expect(pending).resolves.toMatchObject({ ok: true, number: 42 })
  expect(tokens).toEqual(['Alice-token', 'Alice-token'])
  await expect(createGitHubPullRequest(repo.path, input, 'local')).resolves.toMatchObject({
    ok: true,
    number: 43
  })
  expect(tokens.at(-1)).toBe('Bob-token')
})
