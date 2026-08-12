import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const processMocks = vi.hoisted(() => ({
  spawn: vi.fn()
}))

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
  spawn: processMocks.spawn
}))

vi.mock('electron', () => ({
  app: { getPath: () => 'C:\\orca-review-11407' }
}))

vi.mock('../codex-cli/command', () => ({
  resolveClaudeCommand: () => 'claude.exe'
}))

vi.mock('./keychain', () => ({
  deleteActiveClaudeKeychainCredentialsStrict: vi.fn(),
  deleteManagedClaudeKeychainCredentials: vi.fn(),
  readActiveClaudeKeychainCredentials: vi.fn(),
  readActiveClaudeKeychainCredentialsStrict: vi.fn(),
  readManagedClaudeKeychainCredentials: vi.fn(),
  writeActiveClaudeKeychainCredentials: vi.fn(),
  writeManagedClaudeKeychainCredentials: vi.fn()
}))

type CommandConfig = {
  windowsPath: string
  linuxPath: string | null
  wslDistro: string | null
}

type FakeChild = EventEmitter & {
  stdin: PassThrough
  stdout: PassThrough
  stderr: PassThrough
  kill: ReturnType<typeof vi.fn>
  pid: number
}

type CommandRunner = {
  runClaudeCommand(
    args: string[],
    config: CommandConfig,
    timeoutMs: number,
    options?: { keepStdinOpen?: boolean; signal?: AbortSignal }
  ): Promise<string>
}

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { configurable: true, value: platform })
}

function createChild(): FakeChild {
  const child = new EventEmitter() as FakeChild
  child.stdin = new PassThrough()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.kill = vi.fn()
  child.pid = 11407
  return child
}

async function createRunner(): Promise<CommandRunner> {
  const { ClaudeAccountService } = await import('./service')
  return new ClaudeAccountService({} as never, {} as never, {} as never) as unknown as CommandRunner
}

async function flushPromiseCallbacks(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

describe('native Windows Claude login completion oracle', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    processMocks.spawn.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
    if (originalPlatform) {
      Object.defineProperty(process, 'platform', originalPlatform)
    }
  })

  it('settles exact native Windows auth login on exit exactly once and cleans resources', async () => {
    setPlatform('win32')
    const child = createChild()
    const destroyStdin = vi.spyOn(child.stdin, 'destroy')
    const destroyStdout = vi.spyOn(child.stdout, 'destroy')
    const destroyStderr = vi.spyOn(child.stderr, 'destroy')
    const abortController = new AbortController()
    const removeAbortListener = vi.spyOn(abortController.signal, 'removeEventListener')
    processMocks.spawn.mockReturnValue(child)
    const runner = await createRunner()
    let completions = 0
    const command = runner
      .runClaudeCommand(
        ['auth', 'login', '--claudeai'],
        { windowsPath: 'C:\\isolated-auth', linuxPath: null, wslDistro: null },
        1000,
        { keepStdinOpen: true, signal: abortController.signal }
      )
      .then(() => {
        completions += 1
      })

    child.emit('exit', 0)
    await flushPromiseCallbacks()

    try {
      expect(completions).toBe(1)
      expect(child.listenerCount('error')).toBe(0)
      expect(child.listenerCount('exit')).toBe(0)
      expect(child.listenerCount('close')).toBe(0)
      expect(child.stdout.listenerCount('data')).toBe(0)
      expect(child.stderr.listenerCount('data')).toBe(0)
      expect(destroyStdin).toHaveBeenCalledTimes(1)
      expect(destroyStdout).toHaveBeenCalledTimes(1)
      expect(destroyStderr).toHaveBeenCalledTimes(1)
      expect(removeAbortListener).toHaveBeenCalledTimes(1)

      child.emit('close', 0)
      await vi.advanceTimersByTimeAsync(1001)

      expect(completions).toBe(1)
      expect(child.kill).not.toHaveBeenCalled()
      expect(destroyStdin).toHaveBeenCalledTimes(1)
      expect(destroyStdout).toHaveBeenCalledTimes(1)
      expect(destroyStderr).toHaveBeenCalledTimes(1)
      expect(removeAbortListener).toHaveBeenCalledTimes(1)
    } finally {
      child.emit('close', 0)
      await command
    }
  })

  it.each([
    {
      name: 'non-Windows auth login',
      platform: 'linux' as const,
      args: ['auth', 'login', '--claudeai'],
      config: { windowsPath: '/isolated-auth', linuxPath: null, wslDistro: null }
    },
    {
      name: 'unrelated native Windows command containing login',
      platform: 'win32' as const,
      args: ['config', 'login'],
      config: { windowsPath: 'C:\\isolated-auth', linuxPath: null, wslDistro: null }
    },
    {
      name: 'WSL auth login',
      platform: 'win32' as const,
      args: ['auth', 'login', '--claudeai'],
      config: {
        windowsPath: 'C:\\isolated-auth',
        linuxPath: '/home/orca/isolated-auth',
        wslDistro: 'Ubuntu-Oracle'
      }
    }
  ])('preserves close completion for $name', async ({ platform, args, config }) => {
    setPlatform(platform)
    const child = createChild()
    processMocks.spawn.mockReturnValue(child)
    const runner = await createRunner()
    let completions = 0
    const command = runner.runClaudeCommand(args, config, 1000).then(() => {
      completions += 1
    })

    child.emit('exit', 0)
    await flushPromiseCallbacks()

    expect(completions).toBe(0)
    expect(child.listenerCount('close')).toBe(1)

    child.emit('close', 0)
    await command

    expect(completions).toBe(1)
    expect(child.listenerCount('close')).toBe(0)
    expect(child.kill).not.toHaveBeenCalled()
  })
})
