import { once } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { spawnProcess } = vi.hoisted(() => ({ spawnProcess: vi.fn() }))
vi.mock('./run-process', () => ({ spawnProcess }))

import {
  buildWindowsEnvironmentBlock,
  quoteWindowsArgumentLikeLibuv,
  setIsolatedSpawner,
  spawnDetachedWithoutInheritance,
  type IsolatedSpawner
} from './isolated-detached-spawn'

const originalPlatform = process.platform

function onPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform })
}

describe('quoteWindowsArgumentLikeLibuv', () => {
  // The expected outputs are the ones libuv's quote_cmd_arg documents.
  it.each([
    ['', '""'],
    ['hello', 'hello'],
    ['hello\\world', 'hello\\world'],
    ['hello world', '"hello world"'],
    ['hello"world', '"hello\\"world"'],
    ['hello""world', '"hello\\"\\"world"'],
    ['hello\\"world', '"hello\\\\\\"world"'],
    ['hello\\\\"world', '"hello\\\\\\\\\\"world"'],
    ['hello world\\', '"hello world\\\\"'],
    ['C:\\Program Files\\x', '"C:\\Program Files\\x"']
  ])('quotes %j as %s', (value, expected) => {
    expect(quoteWindowsArgumentLikeLibuv(value)).toBe(expected)
  })
})

describe('buildWindowsEnvironmentBlock', () => {
  it('sorts case-insensitively, keeps the first of a duplicate, and ends with two NULs', () => {
    const block = buildWindowsEnvironmentBlock(
      { b: '2', A: '1', B: 'dup', SYSTEMROOT: 'C:\\Windows', skip: undefined },
      {}
    )

    expect(block).toBe('A=1\0b=2\0SYSTEMROOT=C:\\Windows\0\0')
  })

  it('fills required variables from the parent the way libuv does', () => {
    const block = buildWindowsEnvironmentBlock({ X: '1' }, { SystemRoot: 'C:\\W', Other: 'no' })

    expect(block).toBe('SystemRoot=C:\\W\0X=1\0\0')
  })

  it('keeps an empty environment a valid block', () => {
    expect(buildWindowsEnvironmentBlock({}, {})).toBe('\0')
  })
})

describe('spawnDetachedWithoutInheritance', () => {
  afterEach(() => {
    setIsolatedSpawner(null)
    onPlatform(originalPlatform)
    vi.unstubAllEnvs()
    spawnProcess.mockReset()
  })

  it('uses a detached, ignoring libuv spawn off Windows', () => {
    onPlatform('linux')
    const spawner = vi.fn<IsolatedSpawner>()
    setIsolatedSpawner(spawner)
    spawnProcess.mockReturnValue({ pid: 1 })

    spawnDetachedWithoutInheritance({ program: '/bin/true', args: ['x'], cwd: '/' })

    expect(spawner).not.toHaveBeenCalled()
    expect(spawnProcess).toHaveBeenCalledWith({
      program: '/bin/true',
      args: ['x'],
      cwd: '/',
      detached: true,
      stdio: 'ignore'
    })
  })

  it('falls back to libuv on Windows when no spawner is installed', () => {
    onPlatform('win32')
    spawnProcess.mockReturnValue({ pid: 1 })

    spawnDetachedWithoutInheritance({ program: 'C:\\Windows\\System32\\wsl.exe' })

    expect(spawnProcess).toHaveBeenCalledOnce()
  })

  it.each(['C:\\tools\\run.cmd', 'wsl.exe'])('falls back to libuv for %s', (program) => {
    onPlatform('win32')
    const spawner = vi.fn<IsolatedSpawner>()
    setIsolatedSpawner(spawner)
    spawnProcess.mockReturnValue({ pid: 1 })

    spawnDetachedWithoutInheritance({ program, env: { ComSpec: 'cmd.exe' } })

    expect(spawner).not.toHaveBeenCalled()
    expect(spawnProcess).toHaveBeenCalledOnce()
  })

  it('hands the native spawner a libuv-shaped command line and environment block', async () => {
    onPlatform('win32')
    let exit: (code: number) => void = () => {}
    const spawner = vi.fn<IsolatedSpawner>((_file, _line, _cwd, _env, onExit) => {
      exit = onExit
      return { pid: 42, exitWatchError: null }
    })
    setIsolatedSpawner(spawner)

    const child = spawnDetachedWithoutInheritance({
      program: 'C:\\Windows\\System32\\wsl.exe',
      args: ['--exec', '/bin/sh', '-c', 'echo "hi"'],
      cwd: 'C:\\Users\\me',
      env: { WSL_UTF8: '1' }
    })
    await once(child, 'spawn')
    const exited = once(child, 'exit')
    exit(3)

    expect(child.pid).toBe(42)
    expect(await exited).toEqual([3, null])
    expect(spawner).toHaveBeenCalledWith(
      'C:\\Windows\\System32\\wsl.exe',
      'C:\\Windows\\System32\\wsl.exe --exec /bin/sh -c "echo \\"hi\\""',
      'C:\\Users\\me',
      expect.stringMatching(/WSL_UTF8=1\0/),
      expect.any(Function)
    )
    expect(spawnProcess).not.toHaveBeenCalled()
  })

  it('reports exits like libuv: its own kill as a signal, any other exit as the code', async () => {
    onPlatform('win32')
    const exits: ((code: number) => void)[] = []
    let nextPid = 100
    setIsolatedSpawner((_file, _line, _cwd, _env, onExit) => {
      exits.push(onExit)
      return { pid: nextPid++, exitWatchError: null }
    })
    const processKill = vi.spyOn(process, 'kill').mockImplementation(() => true)
    const stopped = spawnDetachedWithoutInheritance({ program: 'C:\\wsl.exe' })
    const killed = spawnDetachedWithoutInheritance({ program: 'C:\\wsl.exe' })

    expect(killed.kill()).toBe(true)
    expect(processKill).toHaveBeenCalledWith(101, 'SIGTERM')
    const stoppedExit = once(stopped, 'exit')
    const killedExit = once(killed, 'exit')
    // The holder exits 1 when its distro stops; TerminateProcess also leaves 1.
    exits[0](1)
    exits[1](1)

    expect(await stoppedExit).toEqual([1, null])
    expect(await killedExit).toEqual([null, 'SIGTERM'])
    expect(killed.kill()).toBe(false)
  })

  it('reports a native spawn failure as an error event, like libuv', async () => {
    onPlatform('win32')
    setIsolatedSpawner(() => {
      throw new Error('CreateProcessW failed with Win32 error 2')
    })

    const child = spawnDetachedWithoutInheritance({ program: 'C:\\missing.exe' })
    const [error] = await once(child, 'error')

    expect(child.pid).toBeUndefined()
    expect(String(error)).toContain('Win32 error 2')
  })

  it('rejects a WSL distro outside the allowlist before spawning', () => {
    onPlatform('win32')
    vi.stubEnv('ORCA_INTERNAL_WSL_DISTRO_ALLOWLIST', 'allowed-distro')
    const spawner = vi.fn<IsolatedSpawner>()
    setIsolatedSpawner(spawner)

    expect(() =>
      spawnDetachedWithoutInheritance({
        program: 'C:\\Windows\\System32\\wsl.exe',
        args: ['-d', 'not-allowed-distro', '--exec', 'true']
      })
    ).toThrow()
    expect(spawner).not.toHaveBeenCalled()
  })
})
