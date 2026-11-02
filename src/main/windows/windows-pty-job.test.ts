import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IPty } from 'node-pty'

const { recordSelfInitiatedTreeKillMock } = vi.hoisted(() => ({
  recordSelfInitiatedTreeKillMock: vi.fn()
}))
vi.mock('../crash-reporting/self-initiated-tree-kill-log', () => ({
  recordSelfInitiatedTreeKill: recordSelfInitiatedTreeKillMock
}))

import {
  __setConptyJobNativeForTests,
  assignHostProcessToKillOnCloseJob,
  isPtyJobOwnershipAvailable,
  listPtyJobProcessIds,
  terminatePtyJob
} from './windows-pty-job'

const ptyWithHandle = (id: unknown, pid = 4242): IPty => ({ _pty: id, pid }) as unknown as IPty

beforeEach(() => {
  recordSelfInitiatedTreeKillMock.mockReset()
})

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
    // Unverifiable ownership must not become successful termination of a live tree.
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
    // winpty/ConPTY IDs can collide; always send shell PID so native code can refuse mismatches.
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
    // Detached/reparented grandchildren escape console and parent-PID walks but remain job members.
    __setConptyJobNativeForTests(() => ({
      terminateJob: vi.fn(),
      listJobProcessIds: vi.fn().mockReturnValue([107184, 91480]),
      assignCurrentProcessToJob: vi.fn().mockReturnValue(true)
    }))
    expect(listPtyJobProcessIds(ptyWithHandle(1))).toEqual([107184, 91480])
  })

  it('reports null when there is no answer to give', () => {
    // Null is unverifiable, including after shell exit closes the job; it never proves death.
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

describe('PTY Job Object teardown breadcrumbs', () => {
  function withNative(terminateJob: () => boolean): void {
    __setConptyJobNativeForTests(() => ({
      terminateJob,
      listJobProcessIds: vi.fn(),
      assignCurrentProcessToJob: vi.fn().mockReturnValue(true)
    }))
  }

  it('records the shell pid whose job it terminated', () => {
    withNative(() => true)

    expect(terminatePtyJob(ptyWithHandle(7, 4242))).toBe('terminated')
    expect(recordSelfInitiatedTreeKillMock).toHaveBeenCalledWith({
      pid: 4242,
      site: 'windows-pty-job-teardown',
      scope: 'win-pty-job'
    })
  })

  it('records nothing when the native side refused', () => {
    withNative(() => false)

    expect(terminatePtyJob(ptyWithHandle(7))).toBe('unavailable')
    expect(recordSelfInitiatedTreeKillMock).not.toHaveBeenCalled()
  })

  it('never downgrades a real termination to unavailable because diagnostics failed', () => {
    // Breadcrumb failure must not downgrade termination to unavailable and escalate taskkill.
    withNative(() => true)
    recordSelfInitiatedTreeKillMock.mockImplementation(() => {
      throw new Error('breadcrumb store exploded')
    })

    expect(() => terminatePtyJob(ptyWithHandle(7))).toThrow('breadcrumb store exploded')
  })
})
