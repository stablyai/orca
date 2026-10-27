import type { ChildProcess } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  completeFakeSpawn,
  createFakeSpawnedChild
} from '../../../../shared/__fixtures__/fake-spawned-child'
import { attachLogFixture, failedLogJob } from './check-job-log-test-fixture'
import { createCheckDetailsAdmissionLifetime } from './check-details-admission-lifetime'
import { prCheckLogTailCache } from './check-job-log-tails'
import { clearGhAccountTokenCacheForTests, resolveGhAccountToken } from '../../gh-account-token'
import {
  clearGhCapabilityStateForTests,
  getGhMultiAccountCapability
} from '../../gh-capability-state'
const { spawnMock, signalMock, forceMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  signalMock: vi.fn(),
  forceMock: vi.fn()
}))
vi.mock('node:child_process', async (original) => ({ ...(await original()), spawn: spawnMock }))
vi.mock('@orca/process-host/process-tree-termination', () => ({
  signalProcessTree: signalMock,
  forceTerminateProcessTree: forceMock
}))
const children: ChildProcess[] = []
describe('shared log auth prerequisite retirement', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    children.length = 0
    clearGhAccountTokenCacheForTests()
    clearGhCapabilityStateForTests()
    prCheckLogTailCache.clear()
    signalMock.mockReset().mockResolvedValue(false)
    forceMock.mockReset().mockResolvedValue(false)
    spawnMock.mockReset().mockImplementation(() => {
      const child = createFakeSpawnedChild(children.length + 700)
      child.kill = vi.fn(() => false)
      children.push(child)
      return child
    })
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
  it('keeps the creator permit through signal-less help to token after every reader departs', async () => {
    const options = {
      cwd: '/folder',
      host: 'github.com',
      ghAccount: { host: 'github.com', user: 'Alice' },
      env: {}
    }
    const creator = new AbortController(),
      follower = new AbortController()
    const release = vi.fn(),
      gate = createCheckDetailsAdmissionLifetime(release)
    const a = attachLogFixture([failedLogJob()], {
      options,
      controller: creator,
      retainUntil: gate.retainUntil
    }).catch(() => {})
    const b = attachLogFixture([failedLogJob()], { options, controller: follower }).catch(() => {})
    await vi.advanceTimersByTimeAsync(0)
    expect(children).toHaveLength(1)
    expect(spawnMock.mock.calls[0][1]).toEqual(['auth', 'token', '--help'])
    creator.abort()
    follower.abort()
    await Promise.all([a, b])
    gate.finish()
    expect(release).not.toHaveBeenCalled()
    completeFakeSpawn(children[0], { stdout: '--user' })
    await vi.advanceTimersByTimeAsync(0)
    expect(children).toHaveLength(2)
    expect(spawnMock.mock.calls[1][1]).toContain('Alice')
    children[1].emit('error', new Error('private token capture'))
    await vi.advanceTimersByTimeAsync(0)
    expect(release).not.toHaveBeenCalled()
    children[1].emit('close', 1, null)
    await vi.advanceTimersByTimeAsync(0)
    expect(release).toHaveBeenCalledOnce()
    expect(spawnMock.mock.calls.filter((call) => call[1][0] === 'api')).toHaveLength(0)
    expect(prCheckLogTailCache.size).toBe(0)
  })

  it('adopts an untracked pending help lifetime even after its result fails before close', async () => {
    const target = { cwd: '/folder' }
    const nowMs = Date.now()
    const untracked = getGhMultiAccountCapability(target, nowMs)
    await vi.advanceTimersByTimeAsync(0)
    expect(children).toHaveLength(1)
    const independent = getGhMultiAccountCapability(target, nowMs)
    const controller = new AbortController()
    const release = vi.fn()
    const gate = createCheckDetailsAdmissionLifetime(release)
    const jobs = [failedLogJob()]
    const result = attachLogFixture(jobs, {
      options: { ...target, ghAccount: { host: 'github.com', user: 'Alice' }, env: {} },
      controller,
      retainUntil: gate.retainUntil
    })
    const rejected = expect(result).rejects.toMatchObject({ name: 'AbortError' })
    await vi.advanceTimersByTimeAsync(0)
    expect(children).toHaveLength(1)
    controller.abort()
    await rejected
    gate.finish()
    expect(release).not.toHaveBeenCalled()
    expect(children[0].kill).not.toHaveBeenCalled()
    children[0].emit('error', new Error('help delivery failed'))
    await expect(untracked).resolves.toBe('unknown')
    await expect(independent).resolves.toBe('unknown')
    await vi.advanceTimersByTimeAsync(0)
    expect(release).not.toHaveBeenCalled()
    expect(children).toHaveLength(1)
    children[0].emit('close', 1, null)
    await vi.advanceTimersByTimeAsync(0)
    expect(release).toHaveBeenCalledOnce()
    children[0].emit('close', 1, null)
    gate.finish()
    await vi.advanceTimersByTimeAsync(0)
    expect(release).toHaveBeenCalledOnce()
    expect(jobs[0]).toMatchObject({ logTail: null, logState: 'not_requested' })
    expect(prCheckLogTailCache.size).toBe(0)
    expect(signalMock).not.toHaveBeenCalled()
    expect(forceMock).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('retains a late tracked join through help to token without cancelling an independent auth reader', async () => {
    const target = { cwd: '/folder' }
    const nowMs = Date.now()
    const untracked = getGhMultiAccountCapability(target, nowMs)
    await vi.advanceTimersByTimeAsync(0)
    const independent = resolveGhAccountToken({ host: 'github.com', user: 'Bob' }, target, nowMs)
    const controller = new AbortController()
    const release = vi.fn()
    const gate = createCheckDetailsAdmissionLifetime(release)
    const jobs = [failedLogJob()]
    const result = attachLogFixture(jobs, {
      options: { ...target, ghAccount: { host: 'github.com', user: 'Alice' }, env: {} },
      controller,
      retainUntil: gate.retainUntil
    })
    const rejected = expect(result).rejects.toMatchObject({ name: 'AbortError' })
    await vi.advanceTimersByTimeAsync(0)
    expect(children).toHaveLength(1)
    expect(spawnMock.mock.calls[0][1]).toEqual(['auth', 'token', '--help'])
    controller.abort()
    await rejected
    gate.finish()
    expect(release).not.toHaveBeenCalled()
    completeFakeSpawn(children[0], { stdout: '--user' })
    await expect(untracked).resolves.toBe('supported')
    await vi.advanceTimersByTimeAsync(0)
    expect(children).toHaveLength(3)
    const aliceIndex = spawnMock.mock.calls.findIndex((call) => call[1].includes('Alice'))
    const bobIndex = spawnMock.mock.calls.findIndex((call) => call[1].includes('Bob'))
    expect(aliceIndex).toBeGreaterThan(0)
    expect(bobIndex).toBeGreaterThan(0)
    expect(release).not.toHaveBeenCalled()
    completeFakeSpawn(children[aliceIndex], { stdout: 'alice-fixture-token' })
    // Physical close alone cannot release before the token/API continuation seals.
    expect(release).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(0)
    expect(release).toHaveBeenCalledOnce()
    expect(children[bobIndex].kill).not.toHaveBeenCalled()
    completeFakeSpawn(children[bobIndex], { stdout: 'bob-fixture-token' })
    await expect(independent).resolves.toBe('bob-fixture-token')
    await vi.advanceTimersByTimeAsync(0)
    expect(spawnMock.mock.calls.filter((call) => call[1][0] === 'api')).toHaveLength(0)
    expect(jobs[0]).toMatchObject({ logTail: null, logState: 'not_requested' })
    expect(prCheckLogTailCache.size).toBe(0)
    expect(release).toHaveBeenCalledOnce()
    expect(signalMock).not.toHaveBeenCalled()
    expect(forceMock).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })
})
