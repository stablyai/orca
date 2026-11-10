import { describe, expect, it, vi } from 'vitest'
import type { ProcessResult, ProcessSpec } from '@orca/process-host/process-spec'
import {
  getPosixPtyForegroundGroup,
  resetPosixPtyForegroundGroupOwnRowCache,
  signalPosixPtyForegroundGroup
} from './posix-pty-foreground-group'

const { runProcessMock } = vi.hoisted(() => ({
  runProcessMock: vi.fn<(spec: ProcessSpec) => Promise<ProcessResult>>()
}))
vi.mock('@orca/process-host', () => ({ runProcess: runProcessMock }))

const psResult = (stdout: string): ProcessResult => ({
  code: 0,
  signal: null,
  stdout,
  stderr: '',
  timedOut: false
})

const macosTable = ['84644 84985 ttys318', '  4242     4242 ttys002'].join('\n')

describe('getPosixPtyForegroundGroup', () => {
  it('refuses when the pid now answers for a different tty', () => {
    // A recycled root PID must not signal another terminal's group.
    expect(getPosixPtyForegroundGroup(macosTable, 84644, '/dev/ttys999', 4242)).toBeNull()
  })

  it('refuses when this process shares the PTY', () => {
    // A dev daemon can inherit its launch TTY; group signals must not reach Orca.
    const shared = ['84644 84985 ttys318', '4242 84985 ttys318'].join('\n')
    expect(getPosixPtyForegroundGroup(shared, 84644, '/dev/ttys318', 4242)).toBeNull()
  })
})

describe('signalPosixPtyForegroundGroup', () => {
  const table = async (): Promise<string> => macosTable

  it('signals the negated foreground group', async () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true)
    const fallback = vi.fn()
    try {
      await signalPosixPtyForegroundGroup(84644, '/dev/ttys318', 'SIGWINCH', fallback, {
        platform: 'darwin',
        currentPid: 4242,
        readProcessTable: table
      })
      expect(kill).toHaveBeenCalledWith(-84985, 'SIGWINCH')
      expect(fallback).not.toHaveBeenCalled()
    } finally {
      kill.mockRestore()
    }
  })
})

it('shares the native master group on resize with own-TTY and lifetime protection', async () => {
  const kill = vi.spyOn(process, 'kill').mockImplementation(() => true)
  const fallback = vi.fn()
  try {
    resetPosixPtyForegroundGroupOwnRowCache()
    runProcessMock.mockResolvedValue(psResult('4242 4242 ttys002'))
    await signalPosixPtyForegroundGroup(900, '/dev/pts/5', 'SIGWINCH', fallback, {
      platform: 'linux',
      currentPid: 4242,
      readForegroundGroup: () => 931,
      ownsRoot: () => true
    })
    expect(kill).toHaveBeenCalledExactlyOnceWith(-931, 'SIGWINCH')
    expect(fallback).not.toHaveBeenCalled()
    kill.mockClear()
    await signalPosixPtyForegroundGroup(900, '/dev/pts/5', 'SIGWINCH', fallback, {
      platform: 'linux',
      currentPid: 4242,
      readForegroundGroup: () => 931,
      ownsRoot: () => false
    })
    expect(kill).not.toHaveBeenCalled()
    await signalPosixPtyForegroundGroup(900, '/dev/ttys002', 'SIGWINCH', fallback, {
      platform: 'linux',
      currentPid: 4242,
      readForegroundGroup: () => 931
    })
    expect(kill).not.toHaveBeenCalled()
    expect(fallback).toHaveBeenCalledOnce()
    resetPosixPtyForegroundGroupOwnRowCache()
    runProcessMock.mockResolvedValue(psResult(''))
    await signalPosixPtyForegroundGroup(900, '/dev/pts/5', 'SIGWINCH', fallback, {
      platform: 'linux',
      currentPid: 4242,
      readForegroundGroup: () => 931
    })
    expect(kill).not.toHaveBeenCalled()
    expect(fallback).toHaveBeenCalledTimes(2)
  } finally {
    kill.mockRestore()
  }
})
