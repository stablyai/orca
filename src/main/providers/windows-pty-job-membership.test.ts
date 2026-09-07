import type * as ChildProcess from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'
import type { IPty } from 'node-pty'

// Module-level, so it intercepts the module's own import binding. A spyOn of a
// require()'d child_process does not: the first version of this test passed
// even with a fork() reintroduced, which is the failure it exists to catch.
const forkMock = vi.hoisted(() => vi.fn())
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof ChildProcess>()),
  fork: forkMock
}))

import { readWindowsPtyJobProcessIds } from './windows-pty-job-membership'

const pty = (pid = 100): IPty => ({ pid }) as unknown as IPty

describe('readWindowsPtyJobProcessIds', () => {
  it('never spawns a child process to answer', () => {
    // The whole point. node-pty answers console membership by FORKING a helper,
    // and Orca asked on a foreground poll, per pane -- hundreds of hidden
    // conpty_console_list_agent processes until the machine ran out of memory
    // (#10857). Killing them changed nothing; the next poll spawned more.
    // QueryInformationJobObject needs no console attachment, so this is one
    // syscall and zero children.
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
    // null is never evidence that processes died
    // (docs/reference/ssh-execution-boundary.md). An empty list means the tree
    // is gone, which this function has never been the one to report.
    expect(readWindowsPtyJobProcessIds(pty(), () => pids)).toBeNull()
  })

  it('drops nonsense pids rather than trusting the whole answer', () => {
    const membership = readWindowsPtyJobProcessIds(pty(), () => [100, 0, -1, 1.5, 200])

    expect(membership).toEqual(new Set([100, 200]))
  })
})

describe('why the filter does NOT use this', () => {
  it('refuses an answer that does not contain the shell', () => {
    // Shell exited, a descendant is still up. Size 1 -- but reading that as
    // "the shell is alone, retire the agent" inverts the truth. The forked
    // probe this replaced required the root in the raw list; so does this.
    const membership = readWindowsPtyJobProcessIds(pty(100), () => [200])

    expect(membership).toBeNull()
  })

  it('is asked with the pty handle, because a bare pid cannot find the job', () => {
    // ptyJobTarget reads node-pty's private `_pty` id off the object and pairs
    // it with proc.pid; the native side refuses on a mismatch. Passing proc.pid
    // instead of proc types fine at some call sites but makes every pane report
    // unverifiable, so pin the argument.
    const listJobProcessIds = vi.fn(() => [100])
    const proc = pty(100)

    readWindowsPtyJobProcessIds(proc, listJobProcessIds)

    expect(listJobProcessIds).toHaveBeenCalledWith(proc)
    expect(listJobProcessIds).not.toHaveBeenCalledWith(100)
  })

  it('documents that job membership keeps console-detached descendants', () => {
    // The candidate filter in windows-agent-foreground-process.ts exists to DROP
    // a descendant that left the console (`Start-Process droid`, a GUI child).
    // The job still contains those by design, so answering that filter from the
    // job would re-admit exactly what it is for -- granting byte authority to a
    // pane no agent owns, or making an attached agent look ambiguous.
    // docs/windows-wsl-root-cause-plan.html calls this out as "Use B".
    //
    // Measured on Windows 11 against a real WSL pane: job [40980,104068,4888,69908]
    // vs console [69908,40980] -- the job is a superset. Harmless for the
    // `size > 1` callers, wrong for the filter.
    const detachedChild = 104068
    const membership = readWindowsPtyJobProcessIds(pty(40980), () => [40980, detachedChild])

    expect(membership?.has(detachedChild)).toBe(true)
  })
})
