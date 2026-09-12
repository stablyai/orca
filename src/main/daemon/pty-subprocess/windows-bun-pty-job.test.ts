import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  __resetWindowsBunPtyJobForTests,
  assignCurrentProcessToBunPtyHostJob,
  createWindowsBunPtyJob,
  type WindowsBunPtyJobNative
} from './windows-bun-pty-job'

function createNative(overrides: Partial<WindowsBunPtyJobNative> = {}): WindowsBunPtyJobNative {
  return {
    createJob: vi.fn(() => 7),
    configureJob: vi.fn(() => true),
    currentProcess: vi.fn(() => 99),
    openProcess: vi.fn((_access, pid) => 1_000 + pid),
    assignProcess: vi.fn(() => true),
    isProcessInJob: vi.fn(() => true),
    queryProcessIds: vi.fn(() => [11]),
    suspendProcess: vi.fn(() => true),
    resumeProcess: vi.fn(() => true),
    terminateJob: vi.fn(() => true),
    closeHandle: vi.fn(),
    ...overrides
  }
}

afterEach(() => {
  __resetWindowsBunPtyJobForTests()
})

describe('Windows Bun PTY job ownership', () => {
  it('assigns the daemon to one kill-on-close host job', () => {
    const native = createNative()

    expect(assignCurrentProcessToBunPtyHostJob(native)).toBe(true)
    expect(assignCurrentProcessToBunPtyHostJob(native)).toBe(true)

    expect(native.createJob).toHaveBeenCalledOnce()
    expect(native.configureJob).toHaveBeenCalledWith(7, 0x2800)
    expect(native.assignProcess).toHaveBeenCalledWith(7, 99)
  })

  it('closes a rejected host job and caches the unavailable result', () => {
    const native = createNative({ assignProcess: vi.fn(() => false) })

    expect(assignCurrentProcessToBunPtyHostJob(native)).toBe(false)
    expect(assignCurrentProcessToBunPtyHostJob(native)).toBe(false)

    expect(native.createJob).toHaveBeenCalledOnce()
    expect(native.closeHandle).toHaveBeenCalledWith(7)
  })

  it('assigns the gated PTY root before exposing the job', () => {
    const native = createNative()

    const job = createWindowsBunPtyJob(11, native)

    expect(job).not.toBeNull()
    expect(native.configureJob).toHaveBeenCalledWith(7, 0x800)
    expect(native.openProcess).toHaveBeenCalledWith(0x1901, 11)
    expect(native.assignProcess).toHaveBeenCalledWith(7, 1011)
    expect(native.closeHandle).toHaveBeenCalledWith(1011)
  })

  it('suspends children that appear during the ownership fence and resumes exact handles', () => {
    const queryProcessIds = vi
      .fn<() => readonly number[] | null>()
      .mockReturnValueOnce([11, 12])
      .mockReturnValueOnce([11, 12, 13])
      .mockReturnValueOnce([11, 12, 13])
      .mockReturnValue([11, 12, 13])
    const native = createNative({ queryProcessIds })
    const job = createWindowsBunPtyJob(11, native)!
    vi.mocked(native.closeHandle).mockClear()

    expect(job.pause()).toBe(true)
    expect(native.suspendProcess).toHaveBeenCalledWith(1011)
    expect(native.suspendProcess).toHaveBeenCalledWith(1012)
    expect(native.suspendProcess).toHaveBeenCalledWith(1013)
    expect(job.resume()).toBe(true)

    expect(native.resumeProcess).toHaveBeenCalledWith(1011)
    expect(native.resumeProcess).toHaveBeenCalledWith(1012)
    expect(native.resumeProcess).toHaveBeenCalledWith(1013)
    expect(native.closeHandle).toHaveBeenCalledWith(1011)
    expect(native.closeHandle).toHaveBeenCalledWith(1012)
    expect(native.closeHandle).toHaveBeenCalledWith(1013)
  })

  it('never suspends a PID whose opened handle is outside the owned job', () => {
    const native = createNative({
      queryProcessIds: vi.fn(() => [11, 12]),
      isProcessInJob: vi.fn((process) => process !== 1012)
    })
    const job = createWindowsBunPtyJob(11, native)!

    expect(job.pause()).toBe(false)

    expect(native.suspendProcess).toHaveBeenCalledWith(1011)
    expect(native.suspendProcess).not.toHaveBeenCalledWith(1012)
    expect(native.resumeProcess).toHaveBeenCalledWith(1011)
    expect(native.closeHandle).toHaveBeenCalledWith(1012)
  })

  it('terminates a paused tree without resuming it first', () => {
    const native = createNative({ queryProcessIds: vi.fn(() => [11]) })
    const job = createWindowsBunPtyJob(11, native)!

    expect(job.pause()).toBe(true)
    expect(job.terminate()).toBe('terminated')
    job.close()

    expect(native.terminateJob).toHaveBeenCalledWith(7)
    expect(native.resumeProcess).not.toHaveBeenCalled()
    expect(native.closeHandle).toHaveBeenCalledWith(1011)
    expect(native.closeHandle).toHaveBeenCalledWith(7)
  })

  it('retains an exact handle when resume fails so a later retry can recover it', () => {
    const resumeProcess = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true)
    const native = createNative({ resumeProcess })
    const job = createWindowsBunPtyJob(11, native)!
    vi.mocked(native.closeHandle).mockClear()

    expect(job.pause()).toBe(true)
    expect(job.resume()).toBe(false)
    expect(native.closeHandle).not.toHaveBeenCalledWith(1011)
    expect(job.resume()).toBe(true)
    expect(native.closeHandle).toHaveBeenCalledWith(1011)
  })

  it('terminates a still-suspended tree instead of abandoning it during close', () => {
    const native = createNative({ resumeProcess: vi.fn(() => false) })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const job = createWindowsBunPtyJob(11, native)!
    vi.mocked(native.closeHandle).mockClear()

    expect(job.pause()).toBe(true)
    job.close()

    expect(native.terminateJob).toHaveBeenCalledWith(7)
    expect(native.closeHandle).toHaveBeenCalledWith(1011)
    expect(native.closeHandle).toHaveBeenCalledWith(7)
    expect(warn).toHaveBeenCalledOnce()
  })
})
