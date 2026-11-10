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
})
