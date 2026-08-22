import { afterEach, describe, expect, it, vi } from 'vitest'
import type { IPty } from 'node-pty'
import {
  __setConptyJobNativeForTests,
  assignHostProcessToKillOnCloseJob,
  isPtyJobOwnershipAvailable,
  listPtyJobProcessIds,
  terminatePtyJob
} from './windows-pty-job'

const ptyWithHandle = (id: unknown, pid = 4242): IPty => ({ _pty: id, pid }) as unknown as IPty

afterEach(() => {
  __setConptyJobNativeForTests()
})

describe('terminatePtyJob', () => {
  it('terminates the job for a pty that has one', () => {
    const terminateJob = vi.fn().mockReturnValue(true)
    __setConptyJobNativeForTests(() => ({
      terminateJob,
      listJobProcessIds: vi.fn(),
      assignCurrentProcessToJob: vi.fn().mockReturnValue(true)
    }))

    expect(terminatePtyJob(ptyWithHandle(7))).toBe('terminated')
    expect(terminateJob).toHaveBeenCalledWith(7, 4242)
  })

  it.each([
    ['no job assigned', false],
    ['native refusal', false]
  ])('reports unavailable rather than success on %s', (_case, nativeResult) => {
    // Why this matters: "we could not tell" is precisely the state the old
    // parent-pid probe returned, and treating it as success is how a live
    // agent tree was declared dead and left holding the worktree open.
    __setConptyJobNativeForTests(() => ({
      terminateJob: vi.fn().mockReturnValue(nativeResult),
      listJobProcessIds: vi.fn(),
      assignCurrentProcessToJob: vi.fn().mockReturnValue(true)
    }))
    expect(terminatePtyJob(ptyWithHandle(7))).toBe('unavailable')
  })

  it.each([
    ['a POSIX terminal with no handle id', undefined],
    ['a non-integer handle id', 'nope']
  ])('reports unavailable for %s', (_case, id) => {
    __setConptyJobNativeForTests(() => ({
      terminateJob: vi.fn().mockReturnValue(true),
      listJobProcessIds: vi.fn(),
      assignCurrentProcessToJob: vi.fn().mockReturnValue(true)
    }))
    expect(terminatePtyJob(ptyWithHandle(id))).toBe('unavailable')
  })

  it('passes the shell pid so an id from another backend cannot match', () => {
    // winpty mints `pty` ids from its own counter and the JS layer stores both
    // in the same field, so an id alone can name a live ConPTY pane. The native
    // side refuses on a pid mismatch; this pins that we always send the pid.
    const terminateJob = vi.fn().mockReturnValue(true)
    __setConptyJobNativeForTests(() => ({
      terminateJob,
      listJobProcessIds: vi.fn(),
      assignCurrentProcessToJob: vi.fn().mockReturnValue(true)
    }))

    terminatePtyJob(ptyWithHandle(3, 9001))
    expect(terminateJob).toHaveBeenCalledWith(3, 9001)
  })

  it('reports unavailable when the shell pid is unusable', () => {
    __setConptyJobNativeForTests(() => ({
      terminateJob: vi.fn().mockReturnValue(true),
      listJobProcessIds: vi.fn(),
      assignCurrentProcessToJob: vi.fn().mockReturnValue(true)
    }))
    expect(terminatePtyJob(ptyWithHandle(3, 0))).toBe('unavailable')
  })

  it('reports unavailable when this build has no job support', () => {
    // A node-pty rebuilt from unpatched sources exports neither symbol.
    __setConptyJobNativeForTests(() => null)
    expect(terminatePtyJob(ptyWithHandle(7))).toBe('unavailable')
    expect(isPtyJobOwnershipAvailable()).toBe(false)
  })

  it('reports unavailable when the native call throws', () => {
    __setConptyJobNativeForTests(() => ({
      terminateJob: vi.fn().mockImplementation(() => {
        throw new Error('handle closed')
      }),
      listJobProcessIds: vi.fn(),
      assignCurrentProcessToJob: vi.fn().mockReturnValue(true)
    }))
    expect(terminatePtyJob(ptyWithHandle(7))).toBe('unavailable')
  })
})

describe('listPtyJobProcessIds', () => {
  it('returns the live pids, including a detached grandchild', () => {
    // Measured on Windows 11: a grandchild spawned detached leaves the console
    // and reparents, so neither GetConsoleProcessList nor a parent-pid walk
    // sees it. Job membership does.
    __setConptyJobNativeForTests(() => ({
      terminateJob: vi.fn(),
      listJobProcessIds: vi.fn().mockReturnValue([107184, 91480]),
      assignCurrentProcessToJob: vi.fn().mockReturnValue(true)
    }))
    expect(listPtyJobProcessIds(ptyWithHandle(1))).toEqual([107184, 91480])
  })

  it('reports null when there is no answer to give', () => {
    // Null is 'unverifiable', never 'they died'. A dead tree also reads null,
    // because node-pty drops its handle record on exit -- so a caller that
    // treats null as proof of death would be right by accident here and wrong
    // on a host that refused the job assignment.
    __setConptyJobNativeForTests(() => null)
    expect(listPtyJobProcessIds(ptyWithHandle(1))).toBeNull()

    __setConptyJobNativeForTests(() => ({
      terminateJob: vi.fn(),
      listJobProcessIds: vi.fn().mockReturnValue(null),
      assignCurrentProcessToJob: vi.fn().mockReturnValue(true)
    }))
    expect(listPtyJobProcessIds(ptyWithHandle(1))).toBeNull()
  })
})

describe('assignHostProcessToKillOnCloseJob', () => {
  it('reports whether the host process is now kill-on-close', () => {
    const assignCurrentProcessToJob = vi.fn().mockReturnValue(true)
    __setConptyJobNativeForTests(() => ({
      terminateJob: vi.fn(),
      listJobProcessIds: vi.fn(),
      assignCurrentProcessToJob
    }))
    expect(assignHostProcessToKillOnCloseJob()).toBe(true)
  })

  it('degrades to false when the OS refuses the assignment', () => {
    // An outer job that forbids nesting; orphan behaviour is then simply what
    // it was before, rather than a crash.
    __setConptyJobNativeForTests(() => ({
      terminateJob: vi.fn(),
      listJobProcessIds: vi.fn(),
      assignCurrentProcessToJob: vi.fn().mockReturnValue(false)
    }))
    expect(assignHostProcessToKillOnCloseJob()).toBe(false)

    __setConptyJobNativeForTests(() => null)
    expect(assignHostProcessToKillOnCloseJob()).toBe(false)
  })
})
