import type { ChildProcess } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  completeFakeSpawn,
  createFakeSpawnedChild
} from '../../../../shared/__fixtures__/fake-spawned-child'
import { attachLogFixture, failedLogJob } from './check-job-log-test-fixture'
import { prCheckLogTailCache } from './check-job-log-tails'
import { createCheckDetailsAdmissionLifetime } from './check-details-admission-lifetime'
import { getPRCheckDetails } from './get-pr-check-details'
const { spawnMock, signalMock, forceMock, resolverMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  signalMock: vi.fn(),
  forceMock: vi.fn(),
  resolverMock: vi.fn()
}))
vi.mock('node:child_process', async (original) => ({ ...(await original()), spawn: spawnMock }))
vi.mock('@orca/process-host/process-tree-termination', () => ({
  signalProcessTree: signalMock,
  forceTerminateProcessTree: forceMock
}))
vi.mock('../../github-api-repository', () => ({ resolveGitHubRepoExecution: resolverMock }))
const children: ChildProcess[] = []
function spawn(): ChildProcess {
  const child = createFakeSpawnedChild(children.length + 100)
  child.kill = vi.fn(() => false)
  children.push(child)
  return child
}
describe('independent readers and positively closed retirement', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    children.length = 0
    spawnMock.mockReset().mockImplementation(spawn)
    signalMock.mockReset().mockResolvedValue(false)
    forceMock.mockReset().mockResolvedValue(false)
    prCheckLogTailCache.clear()
    resolverMock.mockReset().mockResolvedValue({
      ownerRepo: { owner: 'acme', repo: 'widgets' },
      ghOptions: { cwd: '/folder', env: { GH_TOKEN: 'fixture-token' } }
    })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(async () => {
    for (const child of children) {
      child.emit('close', 0, null)
    }
    await vi.advanceTimersByTimeAsync(15_000)
    expect(vi.getTimerCount()).toBe(0)
    vi.useRealTimers()
    vi.restoreAllMocks()
  })
  it.each(['creator', 'follower'])(
    'cancels the %s alone without stopping the remaining reader',
    async (who) => {
      const creator = new AbortController(),
        follower = new AbortController()
      const first = [failedLogJob()],
        second = [failedLogJob()]
      const release = vi.fn(),
        gate = createCheckDetailsAdmissionLifetime(release)
      const a = attachLogFixture(first, { controller: creator, retainUntil: gate.retainUntil })
      const b = attachLogFixture(second, { controller: follower })
      const cancelled = who === 'creator' ? a : b
      const remaining = who === 'creator' ? b : a
      const expected = expect(cancelled).rejects.toMatchObject({ name: 'AbortError' })
      await vi.advanceTimersByTimeAsync(0)
      expect(children).toHaveLength(1)
      ;(who === 'creator' ? creator : follower).abort('private reason')
      await expected
      gate.finish()
      expect(release).not.toHaveBeenCalled()
      expect(signalMock).not.toHaveBeenCalled()
      completeFakeSpawn(children[0], { stdout: 'Error: surviving reader' })
      await remaining
      await vi.advanceTimersByTimeAsync(0)
      expect(release).toHaveBeenCalledOnce()
      expect((who === 'creator' ? first : second)[0]).toMatchObject({
        logState: 'not_requested',
        logTail: null
      })
      expect((who === 'creator' ? second : first)[0]).toMatchObject({
        logState: 'available',
        logTail: 'Error: surviving reader'
      })
      expect(prCheckLogTailCache.size).toBe(1)
    }
  )
  it('keeps a last-detach tombstone through unverified grace, then replaces only after close', async () => {
    const creator = new AbortController(),
      follower = new AbortController()
    const a = attachLogFixture([failedLogJob()], { controller: creator }).catch(() => {})
    const b = attachLogFixture([failedLogJob()], { controller: follower }).catch(() => {})
    await vi.advanceTimersByTimeAsync(0)
    creator.abort()
    follower.abort()
    await Promise.all([a, b])
    const replacementJobs = [failedLogJob()]
    const replacement = attachLogFixture(replacementJobs)
    await vi.advanceTimersByTimeAsync(12_000)
    expect(children).toHaveLength(1)
    expect(prCheckLogTailCache.size).toBe(0)
    children[0].emit('close', null, 'SIGKILL')
    await vi.advanceTimersByTimeAsync(0)
    expect(children).toHaveLength(2)
    children[0].emit('close', null, 'SIGKILL')
    const joiner = attachLogFixture([failedLogJob()])
    await vi.advanceTimersByTimeAsync(0)
    expect(children).toHaveLength(2)
    completeFakeSpawn(children[1], { stdout: 'replacement' })
    await Promise.all([replacement, joiner])
    expect(replacementJobs[0].logTail).toBe('replacement')
  })
  it('bounds retiring joiners by their own deadline and does not start background replacements', async () => {
    const creator = new AbortController()
    const initial = attachLogFixture([failedLogJob()], { controller: creator }).catch(() => {})
    await vi.advanceTimersByTimeAsync(0)
    creator.abort()
    await initial
    const jobs = [failedLogJob()]
    const deadlineJoin = attachLogFixture(jobs, { deadlineAt: Date.now() + 50 })
    const rejection = expect(deadlineJoin).rejects.toMatchObject({ name: 'AbortError' })
    await vi.advanceTimersByTimeAsync(50)
    await rejection
    expect(jobs[0]).toMatchObject({ logState: 'not_requested', logTail: null })
    const aborted = new AbortController()
    aborted.abort()
    await expect(attachLogFixture([failedLogJob()], { controller: aborted })).rejects.toMatchObject(
      { name: 'AbortError' }
    )
    children[0].emit('close', null, 'SIGKILL')
    await vi.advanceTimersByTimeAsync(0)
    expect(children).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(12_000)
  })
  it('rejects an already-aborted joiner and cleans reader listeners without affecting work', async () => {
    const creator = new AbortController(),
      follower = new AbortController()
    const add = vi.spyOn(follower.signal, 'addEventListener'),
      remove = vi.spyOn(follower.signal, 'removeEventListener')
    const first = attachLogFixture([failedLogJob()], { controller: creator })
    const second = attachLogFixture([failedLogJob()], { controller: follower }).catch(() => {})
    await vi.advanceTimersByTimeAsync(0)
    follower.abort()
    await second
    const before = children.length
    await expect(
      attachLogFixture([failedLogJob()], { controller: follower })
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(children).toHaveLength(before)
    expect(remove.mock.calls.filter((call) => call[0] === 'abort').length).toBe(
      add.mock.calls.filter((call) => call[0] === 'abort').length
    )
    completeFakeSpawn(children[0], { stdout: 'ok' })
    await first
  })
  it('natural completion racing with last abort neither mutates nor caches canceled output', async () => {
    const controller = new AbortController(),
      jobs = [failedLogJob()]
    const result = attachLogFixture(jobs, { controller })
    const rejection = expect(result).rejects.toMatchObject({ name: 'AbortError' })
    await vi.advanceTimersByTimeAsync(0)
    completeFakeSpawn(children[0], { stdout: 'late result' })
    controller.abort()
    await rejection
    await vi.advanceTimersByTimeAsync(0)
    expect(prCheckLogTailCache.size).toBe(0)
    expect(jobs[0]).toMatchObject({ logState: 'not_requested', logTail: null })
  })
  it('an earlier follower deadline departs independently; a later follower cannot extend shared work', async () => {
    const first = attachLogFixture([failedLogJob()], { deadlineAt: Date.now() + 1000 })
    const firstReject = expect(first).rejects.toMatchObject({ name: 'AbortError' })
    const earlier = attachLogFixture([failedLogJob()], { deadlineAt: Date.now() + 100 })
    const earlierReject = expect(earlier).rejects.toMatchObject({ name: 'AbortError' })
    const laterJobs = [failedLogJob()]
    const later = attachLogFixture(laterJobs, { deadlineAt: Date.now() + 2000 })
    await vi.advanceTimersByTimeAsync(100)
    await earlierReject
    expect(signalMock).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(900)
    await firstReject
    await later
    expect(laterJobs[0]).toMatchObject({ logState: 'error', logTail: null })
    expect(children).toHaveLength(1)
    expect(prCheckLogTailCache.size).toBe(0)
  })
  it('four retained shared creators prevent a fifth admitted log at unverified grace', async () => {
    const logs: ChildProcess[] = []
    spawnMock.mockImplementation((_program, argv: string[]) => {
      const child = spawn()
      const endpoint = argv.find((arg) => arg.startsWith('repos/')) ?? ''
      if (endpoint.endsWith('/logs')) {
        logs.push(child)
      } else {
        const id = Number(endpoint.match(/runs\/(\d+)/)?.[1])
        queueMicrotask(() =>
          completeFakeSpawn(child, {
            stdout: JSON.stringify({
              jobs: [
                {
                  id,
                  name: 'job',
                  status: 'completed',
                  conclusion: 'failure',
                  completed_at: 'done'
                }
              ]
            })
          })
        )
      }
      return child
    })
    const controllers = Array.from({ length: 4 }, () => new AbortController())
    const requests = controllers.map((controller, i) =>
      getPRCheckDetails(
        '/folder',
        { workflowRunId: i + 1 },
        undefined,
        {},
        controller.signal
      ).catch(() => {})
    )
    await vi.advanceTimersByTimeAsync(0)
    expect(logs).toHaveLength(4)
    const fifthController = new AbortController()
    const fifth = getPRCheckDetails(
      '/folder',
      { workflowRunId: 5 },
      undefined,
      {},
      fifthController.signal
    ).catch(() => {})
    for (const controller of controllers) {
      controller.abort()
    }
    await Promise.all(requests)
    await vi.advanceTimersByTimeAsync(12_000)
    expect(logs).toHaveLength(4)
    logs[0].emit('close', null, 'SIGKILL')
    await vi.advanceTimersByTimeAsync(0)
    expect(logs).toHaveLength(5)
    fifthController.abort()
    await fifth
  })
})
