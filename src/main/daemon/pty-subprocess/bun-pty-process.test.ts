import { constants } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { canUseBunPty, spawnBunPty } from './bun-pty-process'
import type { BunRuntime, BunTerminalOptions } from './bun-pty-process-contract'
import { readWindowsPtyJobProcessIds } from '../../providers/windows-pty-job-membership'
import * as posixPtyGroups from '../../pty/posix-pty-process-groups'

type FakeTerminal = {
  closed: boolean
  write(data: string | ArrayBufferView): number
  resize(cols: number, rows: number): void
  close(): void
}

let testRuntime: NonNullable<Parameters<typeof spawnBunPty>[1]>['runtime']

function createBunHarness({ closeImmediately = true } = {}) {
  let resolveExit: (code: number) => void = () => {}
  let windowsTerminalOptions: BunTerminalOptions | undefined
  const terminal: FakeTerminal = {
    closed: false,
    write: vi.fn(() => 1),
    resize: vi.fn(),
    close: vi.fn(function (this: FakeTerminal) {
      this.closed = true
      if (closeImmediately) {
        windowsTerminalOptions?.exit?.(terminal, 0, null)
      }
    })
  }
  const processHandle = {
    pid: 4321,
    terminal,
    kill: vi.fn(),
    exited: new Promise<number>((resolve) => {
      resolveExit = resolve
    })
  }
  const spawn = vi.fn(
    (_command: string[], _options: Parameters<BunRuntime['spawn']>[1]) => processHandle
  )
  testRuntime = {
    Terminal: class {
      closed = false
      write = terminal.write
      resize = terminal.resize
      close = terminal.close
      constructor(options: BunTerminalOptions) {
        windowsTerminalOptions = options
        return terminal
      }
    },
    spawn
  }
  const emitData = (data: Uint8Array<ArrayBuffer>): void => {
    const options = spawn.mock.calls[0]?.[1]
    const callbacks =
      windowsTerminalOptions ??
      (options && 'data' in options.terminal ? options.terminal : undefined)
    if (!callbacks) {
      throw new Error('missing terminal callbacks')
    }
    callbacks.data(terminal, data)
  }
  return {
    processHandle,
    resolveExit,
    spawn,
    terminal,
    emitData,
    finishTerminal: () => windowsTerminalOptions?.exit?.(terminal, 0, null)
  }
}

function spawn(deps?: Parameters<typeof spawnBunPty>[1]) {
  return spawnBunPty(
    {
      file: '/bin/sh',
      args: ['-l'],
      cwd: '/tmp',
      env: { TERM: 'xterm-256color' },
      cols: 80,
      rows: 24
    },
    { platform: 'linux', runtime: testRuntime, ...deps }
  )
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  testRuntime = undefined
})

describe('Bun.Terminal PTY adapter', () => {
  it('cancels a pending ownership lookup on natural exit without delivering a late stop', async () => {
    const harness = createBunHarness()
    let finishRead: (table: string) => void = () => {}
    const read = vi.spyOn(posixPtyGroups, 'readPosixPtyProcessTable').mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          finishRead = resolve
        })
    )
    const signalProcessGroup = vi.fn()
    const proc = spawn({ signalProcessGroup })
    proc.pause()
    await new Promise<void>((resolve) => setImmediate(resolve))
    const signal = read.mock.calls[0][1]
    expect(signal?.aborted).toBe(false)
    harness.resolveExit(0)
    await harness.processHandle.exited
    expect(signal?.aborted).toBe(true)
    finishRead('4321 4321 pts/test T\n4322 4322 pts/test')
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(signalProcessGroup).not.toHaveBeenCalled()
    expect(harness.processHandle.kill.mock.calls).toEqual([[constants.signals.SIGSTOP]])
  })

  it('cancels a queued resume retry immediately on natural exit', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const harness = createBunHarness()
    const read = vi
      .spyOn(posixPtyGroups, 'readPosixPtyProcessTable')
      .mockResolvedValueOnce('4321 4321 pts/test T\n4322 4322 pts/test')
      .mockRejectedValueOnce(new Error('temporary ps failure'))
    const signalProcessGroup = vi.fn()
    const proc = spawn({ signalProcessGroup })
    proc.pause()
    await new Promise<void>((resolve) => setImmediate(resolve))
    proc.resume()
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(vi.getTimerCount()).toBe(1)
    harness.resolveExit(0)
    await harness.processHandle.exited
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(read).toHaveBeenCalledTimes(2)
    expect(signalProcessGroup.mock.calls).toEqual([
      [4321, 'SIGSTOP'],
      [4322, 'SIGSTOP']
    ])
    expect(harness.processHandle.kill.mock.calls).toEqual([[constants.signals.SIGSTOP]])
  })

  it('exposes initial and successfully applied dimensions for terminal inspection', () => {
    const harness = createBunHarness()
    const proc = spawn()
    expect({ cols: proc.cols, rows: proc.rows }).toEqual({ cols: 80, rows: 24 })
    proc.resize(103, 37)
    expect(harness.terminal.resize).toHaveBeenCalledWith(103, 37)
    expect({ cols: proc.cols, rows: proc.rows }).toEqual({ cols: 103, rows: 37 })
  })

  it.each(['closed', 'exited', 'failed'] as const)(
    'retains last applied dimensions when resize is %s',
    async (reason) => {
      const harness = createBunHarness()
      const proc = spawn()
      proc.resize(103, 37)
      if (reason === 'closed') {
        harness.terminal.closed = true
      }
      if (reason === 'exited') {
        harness.resolveExit(0)
        await harness.processHandle.exited
      }
      if (reason === 'failed') {
        vi.mocked(harness.terminal.resize).mockImplementationOnce(() => {
          throw new Error('closed')
        })
      }
      proc.resize(120, 40)
      expect({ cols: proc.cols, rows: proc.rows }).toEqual({ cols: 103, rows: 37 })
    }
  )

  it('requires Bun.Terminal as well as Bun.spawn', () => {
    const spawn = vi.fn()
    expect(canUseBunPty({ spawn })).toBe(false)
    expect(canUseBunPty({ Terminal: class {}, spawn })).toBe(true)
  })

  it('streams split UTF-8 and reports exit to current and late listeners', async () => {
    const harness = createBunHarness()
    const proc = spawn()
    const onData = vi.fn()
    const onExit = vi.fn()
    proc.onData(onData)
    proc.onExit(onExit)

    const bytes = new TextEncoder().encode('⌘状')
    harness.emitData(bytes.slice(0, 2))
    expect(onData).not.toHaveBeenCalled()
    harness.emitData(bytes.slice(2))
    expect(onData).toHaveBeenCalledWith('⌘状')

    harness.resolveExit(7)
    await harness.processHandle.exited
    await Promise.resolve()
    expect(onExit).toHaveBeenCalledWith({ exitCode: 7 })

    const lateExit = vi.fn()
    proc.onExit(lateExit)
    expect(lateExit).toHaveBeenCalledWith({ exitCode: 7 })
  })

  it('preserves output arriving before the first data listener', () => {
    const harness = createBunHarness()
    const proc = spawn()
    harness.emitData(new TextEncoder().encode('startup output'))
    const listener = vi.fn()
    proc.onData(listener)
    expect(listener).toHaveBeenCalledWith('startup output')
  })

  it('preserves signal termination and never signals the exited handle during disposal', async () => {
    const harness = createBunHarness()
    const proc = spawn()
    Object.assign(harness.processHandle, { signalCode: 'SIGTERM' })
    harness.resolveExit(143)
    await harness.processHandle.exited
    await Promise.resolve()
    const listener = vi.fn()
    proc.onExit(listener)
    proc.destroy()
    expect(listener).toHaveBeenCalledWith({ exitCode: 143, signal: 15 })
    expect(harness.processHandle.kill).not.toHaveBeenCalled()
    expect(harness.terminal.close).toHaveBeenCalledOnce()
  })

  it('disposes data and exit listeners without retaining them', async () => {
    const harness = createBunHarness()
    const proc = spawn()
    const onData = vi.fn()
    const onExit = vi.fn()
    const dataSubscription = proc.onData(onData)
    const exitSubscription = proc.onExit(onExit)

    dataSubscription.dispose()
    exitSubscription.dispose()
    harness.emitData(new TextEncoder().encode('ignored'))
    harness.resolveExit(0)
    await harness.processHandle.exited
    await Promise.resolve()

    expect(onData).not.toHaveBeenCalled()
    expect(onExit).not.toHaveBeenCalled()
  })

  it.each(['darwin', 'linux'] as const)(
    'forwards input, resize, hangup, explicit signals, and destroy on %s',
    (platform) => {
      const harness = createBunHarness()
      const proc = spawn({ platform })

      proc.write('hello')
      proc.resize(120, 40)
      proc.kill()
      proc.kill('SIGTERM')
      proc.kill('SIGINT')
      proc.kill('SIGKILL')
      proc.destroy()

      expect(harness.terminal.write).toHaveBeenCalledWith('hello')
      expect(harness.terminal.resize).toHaveBeenCalledWith(120, 40)
      expect(harness.processHandle.kill.mock.calls).toEqual([
        ['SIGHUP'],
        ['SIGTERM'],
        ['SIGINT'],
        ['SIGKILL'],
        ['SIGHUP']
      ])
      expect(harness.terminal.close).toHaveBeenCalledOnce()
    }
  )

  it('destroys a still-running process even if its terminal has already closed', () => {
    const harness = createBunHarness()
    const proc = spawn()
    harness.terminal.closed = true
    proc.destroy()
    expect(harness.processHandle.kill).toHaveBeenCalledWith('SIGHUP')
    expect(harness.terminal.close).not.toHaveBeenCalled()
  })

  it('contains a native terminal write failure and suppresses later writes', () => {
    const harness = createBunHarness()
    harness.terminal.write = vi.fn(() => {
      throw new Error('terminal closed')
    })
    const proc = spawn()

    expect(() => proc.write('first')).not.toThrow()
    proc.write('second')

    expect(harness.terminal.write).toHaveBeenCalledOnce()
  })

  it('contains a native terminal resize failure and suppresses later resizes', () => {
    const harness = createBunHarness()
    harness.terminal.resize = vi.fn(() => {
      throw new Error('terminal closed')
    })
    const proc = spawn()

    expect(() => proc.resize(120, 40)).not.toThrow()
    proc.resize(100, 30)

    expect(harness.terminal.resize).toHaveBeenCalledOnce()
  })

  it('pauses and resumes the POSIX producer process group once per transition', async () => {
    createBunHarness()
    const signalProcessGroup = vi.fn()
    const proc = spawn({
      readProcessTable: () => ' 4321 4321 pts/test T\n 4322 4322 pts/test',
      signalProcessGroup
    })

    proc.pause()
    proc.pause()
    await vi.waitFor(() => expect(signalProcessGroup).toHaveBeenCalledTimes(2))
    proc.resume()
    proc.resume()
    await vi.waitFor(() => expect(signalProcessGroup).toHaveBeenCalledTimes(4))

    expect(signalProcessGroup.mock.calls).toEqual([
      [4321, 'SIGSTOP'],
      [4322, 'SIGSTOP'],
      [4322, 'SIGCONT'],
      [4321, 'SIGCONT']
    ])
  })

  it('resumes a paused process group before graceful shutdown', async () => {
    const harness = createBunHarness()
    const signalProcessGroup = vi.fn()
    const proc = spawn({
      readProcessTable: () => ' 4321 4321 pts/test T\n 4322 4322 pts/test',
      signalProcessGroup
    })

    proc.pause()
    await vi.waitFor(() => expect(signalProcessGroup).toHaveBeenCalledTimes(2))
    proc.kill()

    expect(signalProcessGroup.mock.calls).toEqual([
      [4321, 'SIGSTOP'],
      [4322, 'SIGSTOP'],
      [4322, 'SIGCONT'],
      [4321, 'SIGCONT']
    ])
    expect(harness.processHandle.kill).toHaveBeenCalledWith('SIGHUP')
  })

  it('falls back to Bun process signals when group signaling is unavailable', async () => {
    const harness = createBunHarness()
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('not supported'), { code: 'EINVAL' })
    })
    const proc = spawn({ readProcessTable: () => '' })

    proc.pause()
    await vi.waitFor(() =>
      expect(harness.processHandle.kill).toHaveBeenCalledWith(constants.signals.SIGSTOP)
    )
    proc.resume()
    await vi.waitFor(() =>
      expect(harness.processHandle.kill).toHaveBeenCalledWith(constants.signals.SIGCONT)
    )

    expect(harness.processHandle.kill.mock.calls).toEqual([
      [constants.signals.SIGSTOP],
      [constants.signals.SIGCONT]
    ])
  })

  it('gates a Windows shell behind exact job ownership and exposes owned capabilities', async () => {
    const harness = createBunHarness({ closeImmediately: false })
    const assignHostJob = vi.fn(() => true)
    const release = vi.fn()
    const dispose = vi.fn()
    const waitForSpawn = vi.fn(async () => {})
    let reportedShellPid: number | undefined
    const job = {
      listProcessIds: vi.fn(() => [4321, 4322]),
      pause: vi.fn(() => true),
      resume: vi.fn(() => true),
      terminate: vi.fn(() => 'terminated' as const),
      close: vi.fn()
    }
    const createJob = vi.fn(() => job)
    const createWindowsLaunch = vi.fn(() => ({
      command: ['cmd.exe', '/d /c launch.cmd'],
      clearCommand: ['cmd.exe', '/d /c clear.cmd'],
      env: { TERM: 'xterm-256color', ORCA_BUN_PTY_JOB_GATE: 'gate' },
      windowsVerbatimArguments: true as const,
      release,
      dispose,
      waitForSpawn,
      readShellProcessId: () => reportedShellPid
    }))
    const proc = spawn({
      platform: 'win32',
      assignHostJob,
      createJob,
      createWindowsLaunch
    })

    expect(harness.spawn.mock.calls[0]?.[0]).toEqual(['cmd.exe', '/d /c launch.cmd'])
    expect(harness.spawn.mock.calls[0]?.[1]).toMatchObject({
      windowsVerbatimArguments: true,
      env: { ORCA_BUN_PTY_JOB_GATE: 'gate' },
      terminal: harness.terminal
    })
    expect(assignHostJob.mock.invocationCallOrder[0]).toBeLessThan(
      harness.spawn.mock.invocationCallOrder[0]
    )
    expect(createJob).toHaveBeenCalledWith(4321)
    expect(createJob.mock.invocationCallOrder[0]).toBeLessThan(release.mock.invocationCallOrder[0])
    await proc.waitForSpawn?.()
    expect(waitForSpawn).toHaveBeenCalledWith(harness.processHandle.exited)

    proc.pause()
    proc.pause()
    proc.resume()
    proc.resume()
    expect(job.pause).toHaveBeenCalledOnce()
    expect(job.resume).toHaveBeenCalledOnce()
    expect(proc.jobRootProcessIsWrapper).toBe(true)
    expect(readWindowsPtyJobProcessIds(proc)).toBeNull()
    expect(harness.spawn.mock.calls[0]?.[1]).not.toHaveProperty('ipc')
    reportedShellPid = 4322
    expect(proc.shellProcessId).toBe(4322)
    expect(readWindowsPtyJobProcessIds(proc)).toEqual(new Set([4322]))
    job.listProcessIds.mockReturnValueOnce([4321, 4323])
    expect(readWindowsPtyJobProcessIds(proc)).toBeNull()
    expect(proc.shellProcessId).toBe(4322)
    expect(proc.listOwnedProcessIds?.()).toEqual([4321, 4322])
    expect(proc.terminateOwnedTree?.()).toBe('terminated')

    job.terminate.mockClear()
    proc.signalProcess?.('SIGINT')
    expect(job.terminate).toHaveBeenCalledOnce()
    expect(harness.processHandle.kill).not.toHaveBeenCalled()

    proc.clear()
    proc.clear()
    expect(harness.spawn.mock.calls[1]?.[0]).toEqual(['cmd.exe', '/d /c clear.cmd'])
    expect(harness.spawn.mock.calls[1]?.[1]).toMatchObject({
      terminal: harness.terminal,
      windowsVerbatimArguments: true
    })
    expect(harness.spawn).toHaveBeenCalledTimes(2)

    const lastOutput = vi.fn()
    const onExit = vi.fn()
    proc.onData(lastOutput)
    proc.onExit(onExit)
    harness.resolveExit(0)
    await harness.processHandle.exited
    await Promise.resolve()
    expect(onExit).not.toHaveBeenCalled()
    expect(job.close).not.toHaveBeenCalled()
    harness.emitData(new TextEncoder().encode('final ConPTY frame'))
    harness.finishTerminal()
    expect(lastOutput).toHaveBeenCalledWith('final ConPTY frame')
    expect(onExit).toHaveBeenCalledOnce()
    expect(job.close).toHaveBeenCalledOnce()
    expect(dispose).toHaveBeenCalledOnce()
    expect(job.resume).toHaveBeenCalledOnce()
    job.resume.mockImplementation(() => {
      throw new Error('job already closed')
    })
    expect(() => {
      proc.pause()
      proc.resume()
      proc.kill()
      proc.destroy()
    }).not.toThrow()
    expect(job.resume).toHaveBeenCalledOnce()
  })

  it('does not release a Windows gate without exact job ownership', async () => {
    const harness = createBunHarness()
    const release = vi.fn()
    const dispose = vi.fn()

    expect(() =>
      spawn({
        platform: 'win32',
        assignHostJob: () => true,
        createJob: () => null,
        createWindowsLaunch: () => ({
          command: ['cmd.exe', '/d /c launch.cmd'],
          clearCommand: ['cmd.exe', '/d /c clear.cmd'],
          env: {},
          windowsVerbatimArguments: true,
          waitForSpawn: async () => {},
          readShellProcessId: () => undefined,
          release,
          dispose
        })
      })
    ).toThrow('Windows Bun PTY job ownership is unavailable')

    expect(release).not.toHaveBeenCalled()
    expect(harness.processHandle.kill).toHaveBeenCalledWith('SIGTERM')
    expect(harness.terminal.close).toHaveBeenCalledOnce()
    expect(dispose).toHaveBeenCalledOnce()
    harness.resolveExit(1)
    await harness.processHandle.exited
    expect(dispose).toHaveBeenCalledTimes(2)
  })

  it('does not spawn a Windows PTY without host crash ownership', () => {
    const harness = createBunHarness()
    const createWindowsLaunch = vi.fn()

    expect(() =>
      spawn({
        platform: 'win32',
        assignHostJob: () => false,
        createWindowsLaunch
      })
    ).toThrow('Windows Bun PTY host crash ownership is unavailable')

    expect(createWindowsLaunch).not.toHaveBeenCalled()
    expect(harness.spawn).not.toHaveBeenCalled()
  })

  it('preserves a Windows PTY after a failed suspension and allows a retry', () => {
    const harness = createBunHarness()
    const job = {
      listProcessIds: vi.fn(() => [4321]),
      pause: vi.fn(() => true).mockReturnValueOnce(false),
      resume: vi.fn(() => true),
      terminate: vi.fn(() => 'terminated' as const),
      close: vi.fn()
    }
    const proc = spawn({
      platform: 'win32',
      assignHostJob: () => true,
      createJob: () => job,
      createWindowsLaunch: () => ({
        command: ['cmd.exe', '/d /c launch.cmd'],
        clearCommand: ['cmd.exe', '/d /c clear.cmd'],
        env: {},
        windowsVerbatimArguments: true,
        waitForSpawn: async () => {},
        readShellProcessId: () => undefined,
        release: vi.fn(),
        dispose: vi.fn()
      })
    })

    proc.pause()
    proc.write('still usable')
    proc.pause()
    proc.resume()

    expect(job.pause).toHaveBeenCalledTimes(2)
    expect(job.resume).toHaveBeenCalledOnce()
    expect(job.terminate).not.toHaveBeenCalled()
    expect(harness.terminal.close).not.toHaveBeenCalled()
    expect(harness.terminal.write).toHaveBeenCalledWith('still usable')

    proc.kill()
    proc.kill('SIGKILL')
    proc.destroy()
    expect(harness.processHandle.kill.mock.calls).toEqual([['SIGTERM'], ['SIGKILL'], ['SIGTERM']])
    expect(job.terminate).toHaveBeenCalledTimes(3)
    expect(harness.terminal.close).toHaveBeenCalledOnce()
  })

  it('delivers Windows exit after cleanup failures', async () => {
    const harness = createBunHarness()
    const cleanupError = new Error('job close failed')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const proc = spawn({
      platform: 'win32',
      assignHostJob: () => true,
      createJob: () => ({
        listProcessIds: vi.fn(() => []),
        pause: vi.fn(() => true),
        resume: vi.fn(() => true),
        terminate: vi.fn(() => 'terminated' as const),
        close: vi.fn(() => {
          throw cleanupError
        })
      }),
      createWindowsLaunch: () => ({
        command: ['cmd.exe', '/d /c launch.cmd'],
        clearCommand: ['cmd.exe', '/d /c clear.cmd'],
        env: {},
        windowsVerbatimArguments: true,
        waitForSpawn: async () => {},
        readShellProcessId: () => undefined,
        release: vi.fn(),
        dispose: vi.fn()
      })
    })
    const onExit = vi.fn()
    proc.onExit(onExit)

    harness.resolveExit(9)
    await harness.processHandle.exited
    await Promise.resolve()

    expect(onExit).toHaveBeenCalledWith({ exitCode: 9 })
    expect(warn).toHaveBeenCalledWith('[daemon/pty] PTY cleanup failed:', cleanupError)
  })

  it('terminates and closes Windows job state when gate release fails', () => {
    const harness = createBunHarness()
    const dispose = vi.fn()
    const job = {
      listProcessIds: vi.fn(() => [4321]),
      pause: vi.fn(() => true),
      resume: vi.fn(() => true),
      terminate: vi.fn(() => 'terminated' as const),
      close: vi.fn()
    }

    expect(() =>
      spawn({
        platform: 'win32',
        assignHostJob: () => true,
        createJob: () => job,
        createWindowsLaunch: () => ({
          command: ['cmd.exe', '/d /c launch.cmd'],
          clearCommand: ['cmd.exe', '/d /c clear.cmd'],
          env: {},
          windowsVerbatimArguments: true,
          waitForSpawn: async () => {},
          readShellProcessId: () => undefined,
          release() {
            throw new Error('gate release failed')
          },
          dispose
        })
      })
    ).toThrow('gate release failed')

    expect(job.terminate).toHaveBeenCalledOnce()
    expect(job.close).toHaveBeenCalledOnce()
    expect(harness.processHandle.kill).toHaveBeenCalledWith('SIGTERM')
    expect(harness.terminal.close).toHaveBeenCalledOnce()
    expect(dispose).toHaveBeenCalledOnce()
  })
})
