import type { ChildProcess, SpawnOptions } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  completeFakeSpawn,
  createFakeSpawnedChild
} from '../../../../shared/__fixtures__/fake-spawned-child'
import { attachLogFixture, failedLogJob } from './check-job-log-test-fixture'
import { prCheckLogTailCache } from './check-job-log-tails'
import { clearGhAccountTokenCacheForTests } from '../../gh-account-token'
import { clearGhCapabilityStateForTests } from '../../gh-capability-state'
const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }))
vi.mock('node:child_process', async (original) => ({ ...(await original()), spawn: spawnMock }))
const children: ChildProcess[] = []
function spawn(): ChildProcess {
  const child = createFakeSpawnedChild()
  children.push(child)
  return child
}
describe('execution snapshot is the environment actually captured', () => {
  beforeEach(() => {
    spawnMock.mockReset()
    children.length = 0
    prCheckLogTailCache.clear()
    clearGhCapabilityStateForTests()
    clearGhAccountTokenCacheForTests()
  })
  afterEach(() => {
    for (const child of children) {
      child.emit('close', 0, null)
    }
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })
  it.each(['output', ''])(
    'pins inherited A through a parser fallback while a new B caller executes separately %#',
    async (value) => {
      vi.stubEnv('GH_TOKEN', 'snapshot-A')
      spawnMock.mockImplementation((_program, argv: string[], options: SpawnOptions) => {
        const child = spawn()
        if (options.env?.GH_TOKEN === 'snapshot-A' && argv.includes('--allow-escape-sequences')) {
          queueMicrotask(() => {
            vi.stubEnv('GH_TOKEN', 'snapshot-B')
            completeFakeSpawn(child, {
              code: 1,
              stderr: 'unknown flag: --allow-escape-sequences\n'
            })
          })
        } else {
          queueMicrotask(() => completeFakeSpawn(child, { stdout: value }))
        }
        return child
      })
      const options = { cwd: '/folder' }
      const first = [failedLogJob()]
      await attachLogFixture(first, { options })
      expect(spawnMock.mock.calls.slice(0, 2).map((call) => call[2].env.GH_TOKEN)).toEqual([
        'snapshot-A',
        'snapshot-A'
      ])
      const second = [failedLogJob()]
      await attachLogFixture(second, { options })
      expect(spawnMock.mock.calls[2][2].env.GH_TOKEN).toBe('snapshot-B')
      vi.stubEnv('GH_TOKEN', 'snapshot-A')
      await attachLogFixture([failedLogJob()], { options })
      expect(spawnMock).toHaveBeenCalledTimes(3)
      expect(prCheckLogTailCache.size).toBe(2)
      expect(first[0].logState).toBe(value ? 'available' : 'empty')
    }
  )
  it('owns override env before deferred spawn and does not inherit missing keys', async () => {
    vi.stubEnv('GH_TOKEN', 'ambient')
    const env = { GITHUB_TOKEN: 'override-A', GH_PROMPT_DISABLED: '' }
    spawnMock.mockImplementation((_program, _argv, options: SpawnOptions) => {
      const child = spawn()
      queueMicrotask(() => completeFakeSpawn(child, { stdout: options.env?.GITHUB_TOKEN }))
      return child
    })
    const jobs = [failedLogJob()]
    const result = attachLogFixture(jobs, { options: { cwd: '/folder', env } })
    env.GITHUB_TOKEN = 'override-B'
    await result
    expect(spawnMock.mock.calls[0][2].env).toMatchObject({
      GITHUB_TOKEN: 'override-A',
      GH_PROMPT_DISABLED: ''
    })
    expect(spawnMock.mock.calls[0][2].env.GH_TOKEN).toBeUndefined()
    expect(jobs[0].logTail).toBe('override-A')
  })
  it('old tenancy credential selection ignores injected cloud token and bypasses B to C stored-account reuse', async () => {
    let stored = 'stored-B'
    spawnMock.mockImplementation((_program, argv: string[], options: SpawnOptions) => {
      const child = spawn()
      const stdout = argv.includes('--help')
        ? '--user'
        : argv[0] === 'auth'
          ? 'requested-A'
          : stored
      if (argv[0] === 'api') {
        expect(options.env?.GH_TOKEN).toBe('requested-A')
      }
      queueMicrotask(() => completeFakeSpawn(child, { stdout }))
      return child
    })
    const repo = { owner: 'acme', repo: 'widgets', host: 'tenant.ghe.com' }
    const options = {
      cwd: '/folder',
      ghAccount: { host: repo.host, user: 'requested-user' },
      env: {}
    }
    const jobs = [failedLogJob()]
    await attachLogFixture(jobs, { repo, options })
    expect(jobs[0].logTail).toBe('stored-B')
    stored = 'stored-C'
    await attachLogFixture(jobs, { repo, options })
    expect(jobs[0].logTail).toBe('stored-C')
    expect(spawnMock.mock.calls.filter((call) => call[1][0] === 'api')).toHaveLength(2)
    expect(prCheckLogTailCache.size).toBe(0)
  })
  it('equivalent option ordering shares but a changed applicable or ignored env value misses conservatively', async () => {
    spawnMock.mockImplementation((_program, _argv, options: SpawnOptions) => {
      const child = spawn()
      queueMicrotask(() =>
        completeFakeSpawn(child, { stdout: options.env?.GH_TOKEN || options.env?.GITHUB_TOKEN })
      )
      return child
    })
    await Promise.all([
      attachLogFixture([failedLogJob()], {
        options: {
          cwd: '/folder',
          encoding: 'utf-8',
          env: { GH_TOKEN: ' ', GITHUB_TOKEN: 'secondary' }
        }
      }),
      attachLogFixture([failedLogJob()], {
        options: {
          env: { GITHUB_TOKEN: 'secondary', GH_TOKEN: ' ' },
          encoding: 'utf-8',
          cwd: '/folder'
        }
      })
    ])
    expect(spawnMock).toHaveBeenCalledOnce()
    await attachLogFixture([failedLogJob()], {
      options: { cwd: '/folder', env: { GH_TOKEN: ' ', GITHUB_TOKEN: 'changed-secondary' } }
    })
    await attachLogFixture([failedLogJob()], {
      options: {
        cwd: '/folder',
        env: { GH_TOKEN: ' ', GITHUB_TOKEN: 'changed-secondary', IGNORED_FIXTURE: 'changed' }
      }
    })
    expect(spawnMock).toHaveBeenCalledTimes(3)
  })
})
