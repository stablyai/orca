import type * as ChildProcess from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'
import type { IPty } from 'node-pty'

// Intercept the ESM import binding; spying on require(child_process) could miss a reintroduced fork.
const forkMock = vi.hoisted(() => vi.fn())
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof ChildProcess>()),
  fork: forkMock
}))

import { readWindowsPtyJobProcessIds } from './windows-pty-job-membership'

const pty = (pid = 100): IPty => ({ pid }) as unknown as IPty

describe('readWindowsPtyJobProcessIds', () => {
  it('never spawns a child process to answer', () => {
    // Foreground polling must use QueryInformationJobObject, never spawn console-list helpers (#10857).
    const listJobProcessIds = vi.fn(() => [100, 200])
    forkMock.mockClear()

    for (let read = 0; read < 50; read += 1) {
      readWindowsPtyJobProcessIds(pty(), listJobProcessIds)
    }

    expect(forkMock).not.toHaveBeenCalled()
    expect(listJobProcessIds).toHaveBeenCalledTimes(50)
  })

  it('reports the shell alone, which is what lets a stale agent be retired', () => {
    const membership = readWindowsPtyJobProcessIds(pty(), () => [100])

    expect(membership).toEqual(new Set([100]))
    expect(membership?.size).toBe(1)
  })

  it('reports descendants, which is what keeps a live agent cached', () => {
    const membership = readWindowsPtyJobProcessIds(pty(), () => [100, 200, 300])

    expect(membership?.size).toBe(3)
  })

  it.each([
    ['no job support or an untracked tree', null],
    ['an empty job, which is not the shell-alone case', []]
  ])('reports unverifiable for %s', (_case, pids) => {
    // Null is unverifiable, never process-exit proof; this reader cannot report an empty tree.
    expect(readWindowsPtyJobProcessIds(pty(), () => pids)).toBeNull()
  })

  it('drops nonsense pids rather than trusting the whole answer', () => {
    const membership = readWindowsPtyJobProcessIds(pty(), () => [100, 0, -1, 1.5, 200])

    expect(membership).toEqual(new Set([100, 200]))
  })
})

describe('why the filter does NOT use this', () => {
  it('refuses an answer that does not contain the shell', () => {
    // A size-one set without the shell means a child survived, never shell-alone proof.
    const membership = readWindowsPtyJobProcessIds(pty(100), () => [200])

    expect(membership).toBeNull()
  })

  it('is asked with the pty handle, because a bare pid cannot find the job', () => {
    // Native lookup needs node-pty private handle id plus PID; a bare PID cannot identify the job.
    const listJobProcessIds = vi.fn(() => [100])
    const proc = pty(100)

    readWindowsPtyJobProcessIds(proc, listJobProcessIds)

    expect(listJobProcessIds).toHaveBeenCalledWith(proc)
    expect(listJobProcessIds).not.toHaveBeenCalledWith(100)
  })

  it('documents that job membership keeps console-detached descendants', () => {
    // Job membership deliberately retains detached children; console candidate filtering must not use it.
    // Measured WSL job [40980,104068,4888,69908] vs console [69908,40980] (windows-wsl-root-cause-plan.html, Use B).
    const detachedChild = 104068
    const membership = readWindowsPtyJobProcessIds(pty(40980), () => [40980, detachedChild])

    expect(membership?.has(detachedChild)).toBe(true)
  })
})
