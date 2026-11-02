import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChildProcess, SpawnOptions } from 'node:child_process'
import {
  completeFakeSpawn,
  createFakeSpawnedChild
} from '../../../../shared/__fixtures__/fake-spawned-child'
import { attachLogFixture, failedLogJob } from './check-job-log-test-fixture'
import { prCheckLogTailCache } from './check-job-log-tails'
import { clearGhCapabilityStateForTests } from '../../gh-capability-state'
import { clearGhAccountTokenCacheForTests } from '../../gh-account-token'
import parserFixture from './__fixtures__/gh-api-unknown-escape-flag.json'
const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }))
vi.mock('node:child_process', async (original) => ({ ...(await original()), spawn: spawnMock }))
const children: ChildProcess[] = []
let raw = 'Error: retained diagnostic'
let active = 0
let peak = 0
function automaticSpawn(_program: string, argv: string[], _options: SpawnOptions): ChildProcess {
  const child = createFakeSpawnedChild()
  children.push(child)
  active += 1
  peak = Math.max(peak, active)
  const user = argv[argv.indexOf('--user') + 1]
  const stdout = argv.includes('--help') ? '--user' : argv[0] === 'auth' ? `bound-${user}` : raw
  queueMicrotask(() => {
    active -= 1
    completeFakeSpawn(child, { stdout })
  })
  return child
}
describe('completed scoped excerpts through actual capture and runner', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    children.length = 0
    active = 0
    peak = 0
    raw = 'Error: retained diagnostic'
    spawnMock.mockReset().mockImplementation(automaticSpawn)
    prCheckLogTailCache.clear()
    clearGhCapabilityStateForTests()
    clearGhAccountTokenCacheForTests()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(async () => {
    for (const child of children) {
      child.emit('close', 0, null)
    }
    await vi.advanceTimersByTimeAsync(0)
    expect(vi.getTimerCount()).toBe(0)
    vi.useRealTimers()
    vi.restoreAllMocks()
  })
  it.each([1, 5])(
    'coalesces two cold %s-job callers, sequentially, and uses warm zero downloads',
    async (count) => {
      const first = Array.from({ length: count }, (_, i) => failedLogJob(i + 1))
      const second = first.map((job) => ({ ...job }))
      const pending = Promise.all([attachLogFixture(first), attachLogFixture(second)])
      await vi.advanceTimersByTimeAsync(0)
      await pending
      expect(spawnMock).toHaveBeenCalledTimes(count)
      expect(peak).toBe(1)
      expect(first).toEqual(second)
      await attachLogFixture(first)
      expect(spawnMock).toHaveBeenCalledTimes(count)
      expect(first.every((job) => job.logState === 'available')).toBe(true)
    }
  )
  it('retries an unchanged failed job and caches only its later successful result', async () => {
    spawnMock.mockImplementationOnce((_program, _argv) => {
      const child = createFakeSpawnedChild()
      queueMicrotask(() => completeFakeSpawn(child, { stderr: 'temporary failure', code: 1 }))
      return child
    })
    const jobs = [failedLogJob()]
    await attachLogFixture(jobs)
    expect(jobs[0]).toMatchObject({
      id: 77,
      completedAt: 'done',
      logTail: null,
      logState: 'error',
      name: 'job 77'
    })
    expect(prCheckLogTailCache.size).toBe(0)
    await attachLogFixture(jobs)
    expect(jobs[0]).toMatchObject({ logState: 'available', logTail: raw })
    await attachLogFixture(jobs)
    expect(spawnMock).toHaveBeenCalledTimes(2)
  })
  it.each([1, 5])(
    'shares old-parser %s-job callers with two physical attempts per unique job',
    async (count) => {
      spawnMock.mockImplementation((_program, argv: string[]) => {
        const child = createFakeSpawnedChild()
        children.push(child)
        active += 1
        peak = Math.max(peak, active)
        queueMicrotask(() => {
          active -= 1
          completeFakeSpawn(
            child,
            argv.includes('--allow-escape-sequences')
              ? { code: parserFixture.code, stderr: parserFixture.stderr }
              : { stdout: 'retrieved' }
          )
        })
        return child
      })
      const jobs = () => Array.from({ length: count }, (_, i) => failedLogJob(i + 1))
      await Promise.all([attachLogFixture(jobs()), attachLogFixture(jobs())])
      expect(spawnMock).toHaveBeenCalledTimes(count * 2)
      expect(
        spawnMock.mock.calls.filter((call) => call[1].includes('--allow-escape-sequences'))
      ).toHaveLength(count)
      expect(peak).toBe(1)
      await attachLogFixture(jobs())
      expect(spawnMock).toHaveBeenCalledTimes(count * 2)
    }
  )
  it.each(['', ' \t \n'])(
    'stores successful exact empty versus whitespace distinctly %#',
    async (value) => {
      raw = value
      const jobs = [failedLogJob()]
      await attachLogFixture(jobs)
      await attachLogFixture(jobs)
      expect(spawnMock).toHaveBeenCalledOnce()
      expect(jobs[0]).toMatchObject({
        logState: value.length ? 'available' : 'empty',
        logTail: value.length ? value : null
      })
      expect([...prCheckLogTailCache.values()][0]).toEqual({
        logState: value.length ? 'available' : 'empty',
        logTail: value.length ? value : null
      })
    }
  )
  it.each([{ status: 'in_progress' }, { completedAt: null }, { completedAt: '' }])(
    'does not cache volatile or missing-completion output %#',
    async (fields) => {
      const jobs = [failedLogJob(77, fields)]
      await attachLogFixture(jobs)
      await attachLogFixture(jobs)
      expect(spawnMock).toHaveBeenCalledTimes(2)
      expect(prCheckLogTailCache.size).toBe(0)
    }
  )
  it('selects the first five eligible IDs, includes warm hits, and retains partial successes', async () => {
    await attachLogFixture([failedLogJob(1)])
    spawnMock.mockImplementation((_program, argv, options) => {
      if (argv.some((arg: string) => arg.endsWith('/2/logs'))) {
        const child = createFakeSpawnedChild()
        queueMicrotask(() => completeFakeSpawn(child, { code: 1, stderr: 'ordinary failure' }))
        return child
      }
      return automaticSpawn(_program, argv, options)
    })
    const jobs = [
      failedLogJob(10, { conclusion: 'success' }),
      failedLogJob(11, { id: null }),
      ...Array.from({ length: 6 }, (_, i) => failedLogJob(i + 1))
    ]
    await attachLogFixture(jobs)
    expect(spawnMock).toHaveBeenCalledTimes(5)
    expect(jobs.map((job) => job.logState)).toEqual([
      'not_requested',
      'not_requested',
      'available',
      'error',
      'available',
      'available',
      'available',
      'not_requested'
    ])
    expect(peak).toBe(1)
  })
  it('bounds owned encoded cache content with FIFO eviction and five-job payload', async () => {
    raw = '🙂'.repeat(6000)
    for (let id = 1; id <= 129; id += 1) {
      await attachLogFixture([failedLogJob(id)])
    }
    expect(prCheckLogTailCache.size).toBe(128)
    const tails = [...prCheckLogTailCache.values()].map((entry) => entry.logTail ?? '')
    expect(tails.every((tail) => Buffer.byteLength(tail) <= 16 * 1024)).toBe(true)
    expect(tails.reduce((bytes, tail) => bytes + Buffer.byteLength(tail), 0)).toBe(128 * 16 * 1024)
    const jobs = Array.from({ length: 5 }, (_, i) => failedLogJob(i + 125))
    await attachLogFixture(jobs)
    expect(jobs.reduce((bytes, job) => bytes + Buffer.byteLength(job.logTail ?? ''), 0)).toBe(
      80 * 1024
    )
    jobs[0].logTail = 'caller mutation'
    await attachLogFixture([failedLogJob(125)])
    expect(spawnMock).toHaveBeenCalledTimes(129)
    await attachLogFixture([failedLogJob(1)])
    expect(spawnMock).toHaveBeenCalledTimes(130)
  })
  it('partitions repository, completion, env and folder scopes', async () => {
    await attachLogFixture([failedLogJob()])
    await attachLogFixture([failedLogJob(77, { completedAt: 'later' })])
    await attachLogFixture([failedLogJob()], { repo: { owner: 'other', repo: 'widgets' } })
    await attachLogFixture([failedLogJob()], {
      options: { cwd: '/other-folder', env: { GH_TOKEN: 'fixture-token' } }
    })
    await attachLogFixture([failedLogJob()], {
      options: { cwd: '/folder', env: { GH_TOKEN: 'different' } }
    })
    expect(spawnMock).toHaveBeenCalledTimes(5)
    await attachLogFixture([failedLogJob()])
    expect(spawnMock).toHaveBeenCalledTimes(5)
  })
  it.each(['github.com', 'github.localhost', 'github.enterprise.test'])(
    'proven bound %s is cold/warm/concurrent 1/0/1 and isolates exact account user',
    async (host) => {
      const repo = { owner: 'acme', repo: 'widgets', host }
      const options = { cwd: '/folder', ghAccount: { host, user: 'Alice' }, env: {} }
      await attachLogFixture([failedLogJob()], { repo, options })
      const countLogs = () => spawnMock.mock.calls.filter((call) => call[1][0] === 'api').length
      expect(countLogs()).toBe(1)
      await attachLogFixture([failedLogJob()], { repo, options })
      expect(countLogs()).toBe(1)
      prCheckLogTailCache.clear()
      await Promise.all([
        attachLogFixture([failedLogJob()], { repo, options }),
        attachLogFixture([failedLogJob()], { repo, options })
      ])
      expect(countLogs()).toBe(2)
      await attachLogFixture([failedLogJob()], {
        repo,
        options: { ...options, ghAccount: { host, user: 'alice' } }
      })
      expect(countLogs()).toBe(3)
      const api = spawnMock.mock.calls.find((call) => call[1][0] === 'api')
      expect(
        api?.[2].env[host === 'github.enterprise.test' ? 'GH_ENTERPRISE_TOKEN' : 'GH_TOKEN']
      ).toBe('bound-Alice')
    }
  )
  it('classic Enterprise secondary token retains 1/0/1 and changed token misses', async () => {
    const repo = { owner: 'acme', repo: 'widgets', host: 'github.enterprise.test' }
    const options = {
      cwd: '/folder',
      env: { GH_ENTERPRISE_TOKEN: '', GITHUB_ENTERPRISE_TOKEN: 'secondary' }
    }
    await attachLogFixture([failedLogJob()], { repo, options })
    await attachLogFixture([failedLogJob()], { repo, options })
    expect(spawnMock).toHaveBeenCalledOnce()
    prCheckLogTailCache.clear()
    await Promise.all([
      attachLogFixture([failedLogJob()], { repo, options }),
      attachLogFixture([failedLogJob()], { repo, options })
    ])
    expect(spawnMock).toHaveBeenCalledTimes(2)
    expect(spawnMock.mock.calls[1][2].env.GITHUB_ENTERPRISE_TOKEN).toBe('secondary')
    await attachLogFixture([failedLogJob()], {
      repo,
      options: { ...options, env: { GITHUB_ENTERPRISE_TOKEN: 'changed' } }
    })
    expect(spawnMock).toHaveBeenCalledTimes(3)
  })
  it.each(['github.com', 'tenant.ghe.com', 'api.github.com', 'github.com:443'])(
    'unproven %s bypass is 1/1/2',
    async (host) => {
      const repo = { owner: 'acme', repo: 'widgets', host }
      const options = {
        cwd: '/folder',
        env: host === 'github.com' ? {} : { GH_TOKEN: 'fixture-token' }
      }
      await attachLogFixture([failedLogJob()], { repo, options })
      await attachLogFixture([failedLogJob()], { repo, options })
      expect(spawnMock).toHaveBeenCalledTimes(2)
      await Promise.all([
        attachLogFixture([failedLogJob()], { repo, options }),
        attachLogFixture([failedLogJob()], { repo, options })
      ])
      expect(spawnMock).toHaveBeenCalledTimes(4)
      expect(prCheckLogTailCache.size).toBe(0)
    }
  )
})
