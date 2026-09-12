import { afterEach, describe, expect, it, vi } from 'vitest'
import { canUseBunPty, spawnBunPty } from './bun-pty-process'

type BunSpawnOptions = {
  terminal: {
    data(terminal: FakeTerminal, data: Uint8Array<ArrayBuffer>): void
  }
}

type FakeTerminal = {
  closed: boolean
  write(data: string | ArrayBufferView): number
  resize(cols: number, rows: number): void
  close(): void
}

let testRuntime: NonNullable<Parameters<typeof spawnBunPty>[1]>['runtime']

function createBunHarness() {
  let resolveExit: (code: number) => void = () => {}
  const terminal: FakeTerminal = {
    closed: false,
    write: vi.fn(() => 1),
    resize: vi.fn(),
    close: vi.fn(function (this: FakeTerminal) {
      this.closed = true
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
  const spawn = vi.fn((_command: string[], _options: unknown) => processHandle)
  testRuntime = { Terminal: class {}, spawn }
  return { processHandle, resolveExit, spawn, terminal }
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
  vi.restoreAllMocks()
  testRuntime = undefined
})

describe('Bun.Terminal PTY adapter', () => {
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

    const options = harness.spawn.mock.calls[0]?.[1] as BunSpawnOptions | undefined
    const bytes = new TextEncoder().encode('⌘状')
    options?.terminal.data(harness.terminal, bytes.slice(0, 2) as Uint8Array<ArrayBuffer>)
    expect(onData).not.toHaveBeenCalled()
    options?.terminal.data(harness.terminal, bytes.slice(2) as Uint8Array<ArrayBuffer>)
    expect(onData).toHaveBeenCalledWith('⌘状')

    harness.resolveExit(7)
    await harness.processHandle.exited
    await Promise.resolve()
    expect(onExit).toHaveBeenCalledWith({ exitCode: 7 })

    const lateExit = vi.fn()
    proc.onExit(lateExit)
    expect(lateExit).toHaveBeenCalledWith({ exitCode: 7 })
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
    const options = harness.spawn.mock.calls[0]?.[1] as BunSpawnOptions | undefined
    options?.terminal.data(harness.terminal, new TextEncoder().encode('ignored'))
    harness.resolveExit(0)
    await harness.processHandle.exited
    await Promise.resolve()

    expect(onData).not.toHaveBeenCalled()
    expect(onExit).not.toHaveBeenCalled()
  })

  it('forwards input, resize, graceful kill, and destroy', () => {
    const harness = createBunHarness()
    const proc = spawn() as ReturnType<typeof spawn> & { destroy(): void }

    proc.write('hello')
    proc.resize(120, 40)
    proc.kill()
    proc.destroy()

    expect(harness.terminal.write).toHaveBeenCalledWith('hello')
    expect(harness.terminal.resize).toHaveBeenCalledWith(120, 40)
    expect(harness.processHandle.kill).toHaveBeenNthCalledWith(1, 'SIGTERM')
    expect(harness.processHandle.kill).toHaveBeenNthCalledWith(2, 'SIGHUP')
    expect(harness.terminal.close).toHaveBeenCalledOnce()
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

  it('pauses and resumes the POSIX producer process group once per transition', () => {
    createBunHarness()
    const signalProcessGroup = vi.fn()
    const proc = spawn({
      readProcessTable: () => ' 4321 4321 pts/test\n 4322 4322 pts/test',
      signalProcessGroup
    }) as ReturnType<typeof spawn> & { pause(): void; resume(): void }

    proc.pause()
    proc.pause()
    proc.resume()
    proc.resume()

    expect(signalProcessGroup.mock.calls).toEqual([
      [4322, 'SIGSTOP'],
      [4321, 'SIGSTOP'],
      [4322, 'SIGCONT'],
      [4321, 'SIGCONT']
    ])
  })

  it('resumes a paused process group before graceful shutdown', () => {
    const harness = createBunHarness()
    const signalProcessGroup = vi.fn()
    const proc = spawn({
      readProcessTable: () => ' 4321 4321 pts/test\n 4322 4322 pts/test',
      signalProcessGroup
    }) as ReturnType<typeof spawn> & { pause(): void }

    proc.pause()
    proc.kill()

    expect(signalProcessGroup.mock.calls).toEqual([
      [4322, 'SIGSTOP'],
      [4321, 'SIGSTOP'],
      [4322, 'SIGCONT'],
      [4321, 'SIGCONT']
    ])
    expect(harness.processHandle.kill).toHaveBeenCalledWith('SIGTERM')
  })

  it('falls back to Bun process signals when group signaling is unavailable', () => {
    const harness = createBunHarness()
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('not supported'), { code: 'EINVAL' })
    })
    const proc = spawn() as ReturnType<typeof spawn> & { pause(): void; resume(): void }

    proc.pause()
    proc.resume()

    expect(harness.processHandle.kill.mock.calls).toEqual([['SIGSTOP'], ['SIGCONT']])
  })

  it('gates a Windows shell behind exact job ownership and exposes owned capabilities', async () => {
    const harness = createBunHarness()
    const assignHostJob = vi.fn(() => true)
    const release = vi.fn()
    const dispose = vi.fn()
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
      dispose
    }))
    const proc = spawn({
      platform: 'win32',
      assignHostJob,
      createJob,
      createWindowsLaunch
    }) as ReturnType<typeof spawn> & {
      clear(): void
      pause(): void
      resume(): void
      signalProcess(signal: string): void
      jobRootProcessIsWrapper: true
      terminateOwnedTree(): 'terminated' | 'unavailable'
      listOwnedProcessIds(): readonly number[] | null
    }

    expect(harness.spawn.mock.calls[0]?.[0]).toEqual(['cmd.exe', '/d /c launch.cmd'])
    expect(harness.spawn.mock.calls[0]?.[1]).toMatchObject({
      windowsVerbatimArguments: true,
      env: { ORCA_BUN_PTY_JOB_GATE: 'gate' }
    })
    expect(assignHostJob.mock.invocationCallOrder[0]).toBeLessThan(
      harness.spawn.mock.invocationCallOrder[0]
    )
    expect(createJob).toHaveBeenCalledWith(4321)
    expect(createJob.mock.invocationCallOrder[0]).toBeLessThan(release.mock.invocationCallOrder[0])

    proc.pause()
    proc.pause()
    proc.resume()
    proc.resume()
    expect(job.pause).toHaveBeenCalledOnce()
    expect(job.resume).toHaveBeenCalledTimes(2)
    expect(proc.jobRootProcessIsWrapper).toBe(true)
    expect(proc.listOwnedProcessIds()).toEqual([4321, 4322])
    expect(proc.terminateOwnedTree()).toBe('terminated')

    job.terminate.mockClear()
    proc.signalProcess('SIGINT')
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

    harness.resolveExit(0)
    await harness.processHandle.exited
    await Promise.resolve()
    expect(job.close).toHaveBeenCalledOnce()
    expect(dispose).toHaveBeenCalledOnce()
  })

  it('does not release a Windows gate without exact job ownership', () => {
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
          release,
          dispose
        })
      })
    ).toThrow('Windows Bun PTY job ownership is unavailable')

    expect(release).not.toHaveBeenCalled()
    expect(harness.processHandle.kill).toHaveBeenCalledWith('SIGTERM')
    expect(harness.terminal.close).toHaveBeenCalledOnce()
    expect(dispose).toHaveBeenCalledOnce()
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

  it('fails closed when a flooding Windows PTY tree cannot be suspended', () => {
    const harness = createBunHarness()
    const job = {
      listProcessIds: vi.fn(() => [4321]),
      pause: vi.fn(() => false),
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
        release: vi.fn(),
        dispose: vi.fn()
      })
    }) as ReturnType<typeof spawn> & { pause(): void }

    proc.pause()

    expect(job.terminate).toHaveBeenCalledOnce()
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
    expect(warn).toHaveBeenCalledWith('[daemon/pty] Windows PTY job cleanup failed:', cleanupError)
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
