import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mockPtyProcess } from '../daemon/pty-subprocess-test-harness'
import { listPtyJobProcessIds, ptyShellProcessId, terminatePtyJob } from './windows-pty-job'

const { recordKill } = vi.hoisted(() => ({ recordKill: vi.fn() }))
vi.mock('../crash-reporting/self-initiated-tree-kill-log', () => ({
  recordSelfInitiatedTreeKill: recordKill
}))
beforeEach(() => {
  recordKill.mockReset()
})

describe('owned Windows PTY jobs', () => {
  it('does not infer job ownership from a PID or an obsolete native handle', () => {
    const proc = { ...mockPtyProcess(4242), _pty: 7 }
    expect(terminatePtyJob(proc)).toBe('unavailable')
    expect(listPtyJobProcessIds(proc)).toBeNull()
    expect(recordKill).not.toHaveBeenCalled()
  })

  it('uses retained ownership and records confirmed termination', () => {
    const terminateOwnedTree = vi.fn(() => 'terminated' as const)
    const proc = { ...mockPtyProcess(4242), terminateOwnedTree }
    expect(terminatePtyJob(proc)).toBe('terminated')
    expect(terminateOwnedTree).toHaveBeenCalledOnce()
    expect(recordKill).toHaveBeenCalledWith({
      pid: 4242,
      site: 'windows-pty-job-teardown',
      scope: 'win-pty-job'
    })
  })

  it.each(['refused', 'throws'])('keeps %s termination unverifiable', (mode) => {
    const proc = {
      ...mockPtyProcess(4242),
      terminateOwnedTree: () => {
        if (mode === 'throws') {
          throw new Error('job unavailable')
        }
        return 'unavailable' as const
      }
    }
    expect(terminatePtyJob(proc)).toBe('unavailable')
    expect(recordKill).not.toHaveBeenCalled()
  })

  it('does not downgrade confirmed termination if diagnostics throw', () => {
    recordKill.mockImplementation(() => {
      throw new Error('diagnostic failure')
    })
    const proc = { ...mockPtyProcess(4242), terminateOwnedTree: () => 'terminated' as const }
    expect(() => terminatePtyJob(proc)).toThrow('diagnostic failure')
  })

  it('preserves live, empty and unverifiable job results', () => {
    for (const result of [[4242, 4243], [], null]) {
      expect(
        listPtyJobProcessIds({ ...mockPtyProcess(4242), listOwnedProcessIds: () => result })
      ).toEqual(result)
    }
    expect(
      listPtyJobProcessIds({
        ...mockPtyProcess(4242),
        listOwnedProcessIds: () => {
          throw new Error('unreadable')
        }
      })
    ).toBeNull()
  })

  it('never substitutes a Windows gate PID for an unknown shell', () => {
    expect(
      ptyShellProcessId({ ...mockPtyProcess(4242), jobRootProcessIsWrapper: true })
    ).toBeUndefined()
    expect(
      ptyShellProcessId({
        ...mockPtyProcess(4242),
        jobRootProcessIsWrapper: true,
        shellProcessId: 4243
      })
    ).toBe(4243)
    expect(ptyShellProcessId(mockPtyProcess(4242))).toBe(4242)
  })
})
