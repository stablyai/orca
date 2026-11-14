import type { ChildProcess } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as excerpt from '../../../../shared/source-control/checks/logs/check-job-log-excerpt'
import * as extraction from '../../../../shared/source-control/checks/logs/check-job-log-tail-slice'
import { TERMINAL_CONTROL_CHARACTER_PATTERN } from '../../../../shared/ansi-escape-sequences'
import { createCheckLogFixture } from '../../../../../config/scripts/performance/check-job-log/check-job-log-test-fixture.mjs'
import {
  completeFakeSpawn,
  createFakeSpawnedChild
} from '../../../../shared/__fixtures__/fake-spawned-child'
import { attachLogFixture, failedLogJob } from './check-job-log-test-fixture'
import { prCheckLogTailCache } from './check-job-log-tails'

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }))
vi.mock('node:child_process', async (original) => ({ ...(await original()), spawn: spawnMock }))
const failureFixture = {
  ...createCheckLogFixture(),
  escapeRefusalStderr:
    'the response contains terminal escape sequences; pass --allow-escape-sequences to output it anyway'
}
const children: ChildProcess[] = []
let raw = ''
let stderr = ''
let code = 0
let active = 0
let peak = 0

function spawn(): ChildProcess {
  const child = createFakeSpawnedChild()
  children.push(child)
  active += 1
  peak = Math.max(peak, active)
  queueMicrotask(() => {
    active -= 1
    completeFakeSpawn(child, { stdout: raw, stderr, code })
  })
  return child
}

function expectSafe(value: string | null): void {
  expect(typeof value).toBe('string')
  if (value === null) {
    throw new Error('Expected available excerpt')
  }
  expect(Buffer.byteLength(value)).toBeLessThanOrEqual(16 * 1024)
  expect(value).not.toContain('\r')
  expect(value).not.toContain('\x1b')
  expect(value).not.toMatch(TERMINAL_CONTROL_CHARACTER_PATTERN)
}

describe('actual shared text pipeline through host capture, cache and jobs', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    children.length = 0
    raw = failureFixture.rawLog
    stderr = ''
    code = 0
    active = 0
    peak = 0
    spawnMock.mockReset().mockImplementation(spawn)
    prCheckLogTailCache.clear()
    vi.spyOn(excerpt, 'sanitizeCheckJobLogExcerpt')
    vi.spyOn(extraction, 'sliceCheckLogTail')
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

  it('captures the real flagged fixture, retains diagnostic/stack and sanitizes once for two readers and warm cache', async () => {
    stderr = failureFixture.escapeRefusalStderr
    const first = [failedLogJob()]
    const second = [failedLogJob()]
    await Promise.all([attachLogFixture(first), attachLogFixture(second)])
    expect(spawnMock).toHaveBeenCalledOnce()
    expect(spawnMock.mock.calls[0][1]).toContain('--allow-escape-sequences')
    expect(extraction.sliceCheckLogTail).toHaveBeenCalledExactlyOnceWith(failureFixture.rawLog)
    expect(excerpt.sanitizeCheckJobLogExcerpt).toHaveBeenCalledOnce()
    const tail = first[0].logTail
    expectSafe(tail)
    expect(tail).toContain(failureFixture.expectedDiagnostic)
    expect(tail).toContain(failureFixture.expectedStackFrame)
    expect(tail).toContain(failureFixture.benignMarker)
    expect(tail).toContain(failureFixture.genericExitMarker)
    const lines = tail?.split('\n') ?? []
    const diagnostic = lines.findIndex((line) => line.includes(failureFixture.expectedDiagnostic))
    const stack = lines.findIndex((line) => line.includes(failureFixture.expectedStackFrame))
    expect(stack - diagnostic).toBeGreaterThan(0)
    expect(stack - diagnostic).toBeLessThan(15)
    expect(first).toEqual(second)
    expect([...prCheckLogTailCache.values()]).toEqual([{ logState: 'available', logTail: tail }])
    expect(JSON.stringify(first)).not.toContain('\\u001b')
    expect(tail).not.toBe(failureFixture.rawLog)
    await attachLogFixture([failedLogJob()])
    expect(spawnMock).toHaveBeenCalledOnce()
    expect(extraction.sliceCheckLogTail).toHaveBeenCalledOnce()
    expect(excerpt.sanitizeCheckJobLogExcerpt).toHaveBeenCalledOnce()
  })

  it('sends bounded Unicode output from oversized captured stdout and handles a cut escape', async () => {
    raw = `discarded-parent-marker${'🙂'.repeat(20_000)}\x1b]unfinished\n\x1b[31mError: HOST_CUT\x1b[0m\n\tat CUT_FRAME.ts:1:2\n`
    const jobs = [failedLogJob()]
    await attachLogFixture(jobs)
    expectSafe(jobs[0].logTail)
    expect(jobs[0].logTail).toContain('Error: HOST_CUT\n\tat CUT_FRAME.ts:1:2')
    expect(jobs[0].logTail).not.toContain('discarded-parent-marker')
    expect(jobs[0].logTail).not.toContain('�')
    const cached = [...prCheckLogTailCache.values()][0]
    expect(cached).toEqual({ logState: 'available', logTail: jobs[0].logTail })
    expect(Object.keys(cached).sort()).toEqual(['logState', 'logTail'])
    expect(Buffer.byteLength(JSON.stringify(jobs))).toBeLessThan(20 * 1024)
  })
})
